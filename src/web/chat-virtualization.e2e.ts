// Chat virtualization stress e2e. Seeds a synthetic 5-agent mesh with 1000
// transcript items per agent and verifies detail/canvas rendering stays bounded.
// Run: bun run src/web/chat-virtualization.e2e.ts
import { type Locator, type Page } from "playwright";
import { authedContext, authedReady, launchChromium, provisionE2eAuth } from "./e2e-playwright";
import { rm } from "node:fs/promises";
import type { GatewayState, MeshSummary, PerMeshState, TranscriptItem } from "./types";

const PORT = Number(process.env.E2E_PORT) || 15089;
const BASE = `http://localhost:${PORT}`;
const MESH = "virtual-stress";
const AGENTS = ["router", "codex-1", "codex-2", "opencode-1", "reviewer"];
const ITEMS_PER_AGENT = 1000;
const BACKFILL_ITEMS_PER_AGENT = 800;
const SNAPSHOT_TRANSCRIPT_ITEMS = 500;
const BACKFILL_LIMIT = 100;
const TAIL_LIMIT = 30;
const ROW_SELECTOR = ".msg, .thought, .tool, .mail, .plan, .session-divider, .compact-entry";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pass = 0;
const fails: string[] = [];
const metrics: Record<string, unknown> = {};

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    fails.push(name);
    console.log(`  ✗ ${name} — ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await authedReady(BASE, auth.token)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("server never became ready");
}

function transcript(agent: string): TranscriptItem[] {
  return Array.from({ length: ITEMS_PER_AGENT }, (_, i): TranscriptItem => {
    const ts = new Date(Date.UTC(2026, 5, 9, 0, 0, i % 60)).toISOString();
    if (i === ITEMS_PER_AGENT - 1) {
      return { id: `${agent}-msg-${i}`, kind: "message", role: "agent", text: `${agent} message ${i} tail sentinel`, complete: true, ts };
    }
    if (i % 41 === 0) return { id: `${agent}-divider-${i}`, kind: "divider", label: "new session", ts };
    if (i % 37 === 0) {
      return {
        id: `${agent}-plan-${i}`,
        kind: "plan",
        entries: [
          { content: `plan ${i} done`, status: "completed" },
          { content: `plan ${i} active`, status: "in_progress" },
          { content: `plan ${i} pending`, status: "pending" },
        ],
        ts,
        updatedTs: ts,
      };
    }
    if (i % 29 === 0) {
      return {
        id: `${agent}-tool-${i}`,
        kind: "tool_call",
        toolCallId: `${agent}-tc-${i}`,
        title: `read src/file-${i}.ts`,
        status: "completed",
        input: `cat src/file-${i}.ts`,
        output: `line ${i}\n`.repeat(80),
        locations: [`src/file-${i}.ts`],
        ts,
        updatedTs: ts,
      };
    }
    if (i % 19 === 0) return { id: `${agent}-mail-${i}`, kind: "mail", from: "lead", to: agent, body: `mail ${i}\n`.repeat(10), ts };
    if (i % 13 === 0) return { id: `${agent}-thought-${i}`, kind: "thought", text: `thought ${i}\n`.repeat(80), complete: true, ts };
    return {
      id: `${agent}-msg-${i}`,
      kind: "message",
      role: i % 2 ? "agent" : "user",
      text: `${agent} message ${i} ` + "x".repeat(i % 17 === 0 ? 1800 : 160),
      complete: true,
      ts,
    };
  });
}

function backfillTranscript(agent: string): TranscriptItem[] {
  return Array.from({ length: BACKFILL_ITEMS_PER_AGENT }, (_, i): TranscriptItem => {
    const ts = new Date(Date.UTC(2026, 5, 9, 1, 0, i % 60)).toISOString();
    if (i % 23 === 0) {
      return {
        id: `${agent}-backfill-tool-${i}`,
        kind: "tool_call",
        toolCallId: `${agent}-backfill-tc-${i}`,
        title: `inspect history ${i}`,
        status: "completed",
        output: `older line ${i}\n`.repeat(24),
        ts,
        updatedTs: ts,
      };
    }
    if (i % 17 === 0) return { id: `${agent}-backfill-mail-${i}`, kind: "mail", from: "lead", to: agent, body: `older mail ${i}\n`.repeat(5), ts };
    if (i % 11 === 0) return { id: `${agent}-backfill-thought-${i}`, kind: "thought", text: `older thought ${i}\n`.repeat(20), complete: true, ts };
    return {
      id: `${agent}-backfill-msg-${i}`,
      kind: "message",
      role: i % 2 ? "agent" : "user",
      text: `${agent} older message ${i} ` + "y".repeat(i % 13 === 0 ? 1200 : 100),
      complete: true,
      ts,
    };
  });
}

function seededBackfillState(): { state: GatewayState; full: TranscriptItem[]; tail: TranscriptItem[]; older: TranscriptItem[] } {
  const full = backfillTranscript("router");
  const tail = full.slice(BACKFILL_ITEMS_PER_AGENT - SNAPSHOT_TRANSCRIPT_ITEMS);
  const older = full.slice(BACKFILL_ITEMS_PER_AGENT - SNAPSHOT_TRANSCRIPT_ITEMS - BACKFILL_LIMIT, BACKFILL_ITEMS_PER_AGENT - SNAPSHOT_TRANSCRIPT_ITEMS);
  const state = seededState();
  state.perMesh[MESH].transcripts.router = { items: tail, hasMore: true, oldestSeq: tail[0].id };
  return { state, full, tail, older };
}

function seededLazyInitialState(agent = "codex-1"): { state: GatewayState; full: TranscriptItem[] } {
  const full = backfillTranscript(agent).slice(0, SNAPSHOT_TRANSCRIPT_ITEMS);
  const state = seededState();
  state.perMesh[MESH].transcripts[agent] = { items: [], hasMore: true };
  return { state, full };
}

function seededState(): GatewayState {
  const agents: MeshSummary["agents"] = AGENTS.map((id, i) => ({
    id,
    harness: i === 3 ? "opencode" : "codex",
    role: id === "router" ? "router" : "member",
    status: "ready",
    activity: "idle",
  }));
  const mesh: MeshSummary = {
    name: MESH,
    defined: true,
    status: "running",
    router: "router",
    agents,
    edges: [
      { from: "router", to: "codex-1" },
      { from: "router", to: "codex-2" },
      { from: "codex-1", to: "opencode-1" },
      { from: "opencode-1", to: "reviewer" },
    ],
  };
  const pm: PerMeshState = {
    config: { name: MESH, agents: [], edges: mesh.edges },
    transcripts: Object.fromEntries(AGENTS.map((agent) => [agent, { items: transcript(agent), hasMore: false, oldestSeq: `${agent}-msg-0` }])),
    activity: [],
    mail: [],
    pending: [],
    history: [],
    modes: {},
    models: {},
    efforts: {},
    capabilities: Object.fromEntries(AGENTS.map((agent) => [agent, { image: false }])),
    usage: {},
    health: {},
    selfAwareness: {},
    queues: {},
    board: null,
  };
  return { meshes: [mesh], assistant: { status: "absent", transcript: [], capabilities: { image: false } }, perMesh: { [MESH]: pm } };
}

async function seed(page: Page) {
  await page.evaluate((state) => {
    (window as any).__meshStore.apply({ t: "snapshot", state });
  }, seededState());
  await page.waitForSelector(`.mrow:has-text("${MESH}")`, { timeout: 8000 });
  await page.locator(`.mrow:has-text("${MESH}")`).first().click();
  await page.waitForSelector(`.detail-head:has-text("${MESH}")`, { timeout: 8000 });
}

async function visibleRows(scope: Locator): Promise<number> {
  return scope.locator(ROW_SELECTOR).count();
}

async function activeStream(page: Page): Promise<Locator> {
  const stream = page.locator(".conv-panel .stream.virtual-stream").first();
  await stream.waitFor({ timeout: 5000 });
  return stream;
}

const auth = await provisionE2eAuth();
const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT)], {
  stdout: "pipe",
  stderr: "pipe",
  env: auth.env,
});
const browser = await launchChromium();

try {
  await waitReady();
  const ctx = await authedContext(browser, auth.token, { viewport: { width: 1440, height: 900 } });
  const page: Page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".brand", { timeout: 8000 });
  await page.route(`**/api/meshes/${MESH}/agents/*/transcript?**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], hasMore: false }),
    });
  });
  await seed(page);

  await step("Scenario A: large transcript tabs keep bounded DOM rows and jump to bottom", async () => {
    const counts: Record<string, number> = {};
    for (const agent of AGENTS) {
      if (agent === "router") await page.locator(".conv-router-tab").click();
      else await page.locator(`.conv-member-tab:has-text("${agent}")`).click();
      await page.waitForSelector(`.conv-panel .head .sub:has-text("${agent}")`, { timeout: 5000 });
      const panel = page.locator(".conv-panel").first();
      const count = await visibleRows(panel);
      counts[agent] = count;
      if (count >= 80) throw new Error(`${agent} rendered ${count} rows`);

      const stream = await activeStream(page);
      await stream.focus();
      await page.keyboard.press("PageUp");
      await page.waitForTimeout(80);
      await page.locator(".conv-panel .jump-bottom").waitFor({ timeout: 5000 });
      await page.locator(".conv-panel .jump-bottom").click();
      await page.waitForSelector(`.conv-panel:has-text("${agent} message 999 tail sentinel")`, { timeout: 5000 });
    }
    metrics.scenarioA = counts;
  });

  await step("Scenario B: canvas windows cap focused and non-focused transcript DOM", async () => {
    const openedAt = performance.now();
    await page.evaluate(() => {
      const panels = [...document.querySelectorAll(".panel")] as HTMLElement[];
      const topology = panels.find((panel) => panel.querySelector(".head .ttl")?.textContent?.trim() === "topology");
      const button = topology?.querySelector('button[title="expand topology"]') as HTMLButtonElement | null;
      if (!button) throw new Error("missing topology canvas button");
      button.click();
    });
    const canvas = page.locator(".mesh-canvas");
    await canvas.waitFor({ timeout: 5000 });
    const elapsed = Math.round(performance.now() - openedAt);
    const focused = canvas.locator('.canvas-window-body[data-transcript-mode="full"]').first();
    const focusedRows = await visibleRows(focused);
    if (focusedRows >= 80) throw new Error(`focused canvas rendered ${focusedRows} rows`);
    const tailCounts = await canvas.locator('.canvas-window-body[data-transcript-mode="tail"]').evaluateAll((bodies, selector) =>
      bodies.map((body) => body.querySelectorAll(String(selector)).length),
    ROW_SELECTOR);
    if (tailCounts.length !== 4) throw new Error(`expected 4 non-focused windows, got ${tailCounts.length}`);
    for (const count of tailCounts) {
      if (count > TAIL_LIMIT) throw new Error(`non-focused canvas rendered ${count} rows`);
    }
    const totalRows = await visibleRows(canvas);
    if (totalRows >= 200) throw new Error(`canvas rendered ${totalRows} total rows`);
    metrics.scenarioB = { focusedRows, tailCounts, totalRows, openMs: elapsed };
    await canvas.locator(".canvas-close").click();
    await canvas.waitFor({ state: "detached", timeout: 4000 });
  });

  await step("Scenario C: expanding an above-viewport row preserves the viewport anchor", async () => {
    await page.locator(".conv-router-tab").click();
    const stream = await activeStream(page);
    await stream.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await stream.hover();
    await page.mouse.wheel(0, -2_000);
    await page.waitForTimeout(400);
    await stream.evaluate((el) => {
      el.scrollTop = 1_000;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForTimeout(80);
    let probe: { anchorIndex: string; before: number } | null = null;
    for (const scrollTop of [8_000, 16_000, 24_000, 32_000, 40_000, 48_000, 56_000]) {
      await stream.evaluate((el, scrollTop) => {
        el.scrollTop = scrollTop;
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
      }, scrollTop);
      await page.waitForTimeout(80);
      probe = await page.locator(".conv-panel").evaluate(() => {
        const stream = document.querySelector(".conv-panel .stream.virtual-stream") as HTMLElement | null;
        if (!stream) return null;
        const streamBox = stream.getBoundingClientRect();
        const rows = [...document.querySelectorAll(".conv-panel [data-virtual-row='true']")] as HTMLElement[];
        const row = rows.find((candidate) => {
          const box = candidate.getBoundingClientRect();
          return box.top >= streamBox.top && box.bottom <= streamBox.bottom;
        });
        if (!row) return null;
        const anchorTop = row.getBoundingClientRect().top;
        const expandableRow = rows.reverse().find((candidate) => {
          const box = candidate.getBoundingClientRect();
          return box.bottom < streamBox.top && !!candidate.querySelector(".tool .thead, .thought .label");
        });
        if (!expandableRow) return null;
        (expandableRow.querySelector(".tool .thead, .thought .label") as HTMLElement).click();
        return { anchorIndex: row.getAttribute("data-index") ?? "", before: anchorTop };
      });
      if (probe) break;
    }
    if (!probe) throw new Error("missing above-viewport expandable row");
    await page.waitForTimeout(120);
    const anchor = page.locator(`.conv-panel [data-virtual-row='true'][data-index="${probe.anchorIndex}"]`);
    const before = probe.before;
    const after = await anchor.evaluate((el) => (el as HTMLElement).getBoundingClientRect().top);
    const delta = Math.abs(after - before);
    metrics.scenarioC = { before, after, delta };
    if (delta >= 5) throw new Error(`viewport anchor moved ${delta}px`);
  });

  await step("Scenario D: append follows when already at bottom", async () => {
    await page.locator(".conv-router-tab").click();
    const stream = await activeStream(page);
    await stream.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const id = `router-msg-append-${Date.now()}`;
    await page.evaluate(({ mesh, id }) => {
      (window as any).__meshStore.apply({
        t: "transcript.upsert",
        conv: { scope: "mesh", mesh, agent: "router" },
        item: { id, kind: "message", role: "agent", text: "router appended virtualization sentinel", complete: true, ts: new Date().toISOString() },
      });
    }, { mesh: MESH, id });
    await page.waitForSelector('.conv-panel:has-text("router appended virtualization sentinel")', { timeout: 5000 });
    const distance = await stream.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    metrics.scenarioD = { distanceFromBottom: distance };
    if (distance > 48) throw new Error(`append did not follow bottom, distance=${distance}`);
  });

  await step("Scenario E: layout-only virtual scroll drift does not break append follow", async () => {
    await page.locator(".conv-router-tab").click();
    const stream = await activeStream(page);
    await stream.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForTimeout(80);
    await stream.evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollTop - 240);
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const id = `router-msg-layout-drift-${Date.now()}`;
    await page.evaluate(({ mesh, id }) => {
      (window as any).__meshStore.apply({
        t: "transcript.upsert",
        conv: { scope: "mesh", mesh, agent: "router" },
        item: { id, kind: "message", role: "agent", text: "router layout drift follow sentinel", complete: true, ts: new Date().toISOString() },
      });
    }, { mesh: MESH, id });
    await page.waitForSelector('.conv-panel:has-text("router layout drift follow sentinel")', { timeout: 5000 });
    const distance = await stream.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    metrics.scenarioE = { distanceFromBottom: distance };
    if (distance > 48) throw new Error(`layout-only scroll drift disabled bottom follow, distance=${distance}`);
  });

  await step("Scenario F: snapshot tail backfills older transcript without anchor jump", async () => {
    const seeded = seededBackfillState();
    let releaseBackfill: (() => void) | undefined;
    let backfillRequested = false;
    let scenarioFRequests = 0;
    await page.route(`**/api/meshes/${MESH}/agents/router/transcript?**`, async (route) => {
      backfillRequested = true;
      scenarioFRequests += 1;
      if (scenarioFRequests > 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [], hasMore: false }),
        });
        return;
      }
      await new Promise<void>((resolve) => {
        releaseBackfill = resolve;
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: seeded.older, hasMore: false }),
      });
    });

    await page.evaluate((state) => {
      (window as any).__meshStore.apply({ t: "snapshot", state });
    }, seeded.state);
    await page.locator(".conv-router-tab").click();
    await page.waitForFunction(({ mesh, expected }) => {
      return (window as any).__meshStore.getState().perMesh[mesh].transcripts.router.items.length === expected;
    }, { mesh: MESH, expected: SNAPSHOT_TRANSCRIPT_ITEMS }, { timeout: 5000 });

    const initial = await page.evaluate(({ mesh }) => {
      const tr = (window as any).__meshStore.getState().perMesh[mesh].transcripts.router;
      return { length: tr.items.length, hasMore: tr.hasMore, oldestSeq: tr.oldestSeq, firstId: tr.items[0].id };
    }, { mesh: MESH });
    if (initial.length !== SNAPSHOT_TRANSCRIPT_ITEMS) throw new Error(`snapshot length ${initial.length}`);
    if (initial.hasMore !== true) throw new Error("snapshot missing hasMore");
    if (initial.oldestSeq !== initial.firstId) throw new Error(`oldestSeq ${initial.oldestSeq} did not match first id ${initial.firstId}`);

    const stream = await activeStream(page);
    await stream.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector(".conv-panel .virtual-transcript-loading")?.textContent?.includes("Loading older"), null, { timeout: 3000 });
    for (let i = 0; i < 20 && !backfillRequested; i++) await page.waitForTimeout(50);
    if (!backfillRequested || !releaseBackfill) throw new Error("backfill request was not issued");

    const anchor = await page.locator(".conv-panel").evaluate(() => {
      const stream = document.querySelector(".conv-panel .stream.virtual-stream") as HTMLElement | null;
      if (!stream) return null;
      const streamBox = stream.getBoundingClientRect();
      const rows = [...document.querySelectorAll(".conv-panel [data-virtual-row='true']")] as HTMLElement[];
      const row = rows.find((candidate) => {
        const box = candidate.getBoundingClientRect();
        return box.top >= streamBox.top && box.bottom <= streamBox.bottom;
      });
      return row ? { index: row.getAttribute("data-index") ?? "", id: row.getAttribute("data-item-id") ?? "", top: row.getBoundingClientRect().top } : null;
    });
    if (!anchor) throw new Error("missing visible anchor before backfill");

    releaseBackfill();
    await page.waitForFunction(({ mesh, expected }) => {
      return (window as any).__meshStore.getState().perMesh[mesh].transcripts.router.items.length === expected;
    }, { mesh: MESH, expected: SNAPSHOT_TRANSCRIPT_ITEMS + BACKFILL_LIMIT }, { timeout: 5000 });
    await page.waitForTimeout(120);

    const after = await page.locator(".conv-panel").evaluate((_panel, arg: { anchorText: string }) => {
      const rows = [...document.querySelectorAll(".conv-panel [data-virtual-row='true']")] as HTMLElement[];
      const row = rows.find((candidate) => candidate.getAttribute("data-item-id") === arg.anchorText);
      return row?.getBoundingClientRect().top ?? null;
    }, { anchorText: anchor.id });
    if (after == null) throw new Error("anchor row disappeared after backfill");
    const delta = Math.abs(after - anchor.top);
    const finalState = await page.evaluate(({ mesh }) => {
      const tr = (window as any).__meshStore.getState().perMesh[mesh].transcripts.router;
      return { length: tr.items.length, hasMore: tr.hasMore, oldestSeq: tr.oldestSeq, firstId: tr.items[0].id };
    }, { mesh: MESH });
    metrics.scenarioF = { initial, final: finalState, anchorDelta: Math.round(delta * 100) / 100 };
    if (finalState.length !== SNAPSHOT_TRANSCRIPT_ITEMS + BACKFILL_LIMIT) throw new Error(`backfill length ${finalState.length}`);
    if (finalState.oldestSeq !== seeded.older[0].id) throw new Error(`oldestSeq after backfill ${finalState.oldestSeq}`);
    if (delta >= 20) throw new Error(`backfill anchor moved ${delta}px`);
    await page.evaluate((mesh) => {
      const state = structuredClone((window as any).__meshStore.getState());
      const tr = state.perMesh[mesh].transcripts.router;
      tr.hasMore = false;
      (window as any).__meshStore.apply({ t: "snapshot", state });
    }, MESH);
    await page.unroute(`**/api/meshes/${MESH}/agents/router/transcript?**`);
  });

  await step("Scenario G: repeated near-top backfill stops when all history is loaded", async () => {
    const seeded = seededBackfillState();
    let requests = 0;
    await page.route(`**/api/meshes/${MESH}/agents/router/transcript?**`, async (route) => {
      const before = new URL(route.request().url()).searchParams.get("before");
      requests += 1;
      const beforeIndex = seeded.full.findIndex((item) => item.id === before);
      const start = Math.max(0, beforeIndex - BACKFILL_LIMIT);
      const items = beforeIndex >= 0 ? seeded.full.slice(start, beforeIndex) : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items, hasMore: start > 0 }),
      });
    });

    await page.evaluate((state) => {
      (window as any).__meshStore.apply({ t: "snapshot", state });
    }, seeded.state);
    await page.locator(".conv-router-tab").click();
    for (const expected of [600, 700, 800]) {
      await page.evaluate(({ mesh }) => (window as any).__meshStore.loadOlderTranscript(mesh, "router"), { mesh: MESH });
      await page.waitForFunction(({ mesh, expected }) => {
        return (window as any).__meshStore.getState().perMesh[mesh].transcripts.router.items.length >= expected;
      }, { mesh: MESH, expected }, { timeout: 5000 });
    }
    const finalState = await page.evaluate(({ mesh }) => {
      const tr = (window as any).__meshStore.getState().perMesh[mesh].transcripts.router;
      return { length: tr.items.length, hasMore: tr.hasMore, oldestSeq: tr.oldestSeq, firstId: tr.items[0].id };
    }, { mesh: MESH });
    if (finalState.length !== BACKFILL_ITEMS_PER_AGENT) throw new Error(`loaded ${finalState.length} items`);
    if (finalState.hasMore !== false) throw new Error("hasMore stayed true after full history loaded");
    if (finalState.oldestSeq !== seeded.full[0].id) throw new Error(`oldestSeq ${finalState.oldestSeq}`);
    const requestCountAfterComplete = requests;
    await page.evaluate(({ mesh }) => (window as any).__meshStore.loadOlderTranscript(mesh, "router"), { mesh: MESH });
    await page.waitForTimeout(250);
    if (requests !== requestCountAfterComplete) throw new Error(`extra backfill after hasMore=false: ${requests}`);
    metrics.scenarioG = { final: finalState, requests };
    await page.unroute(`**/api/meshes/${MESH}/agents/router/transcript?**`);
  });

  await step("Scenario H: empty snapshot transcript lazy-loads tail before older backfill", async () => {
    const agent = "codex-1";
    const seeded = seededLazyInitialState(agent);
    let tailRequests = 0;
    let backfillRequests = 0;
    await page.unroute(`**/api/meshes/${MESH}/agents/*/transcript?**`);
    await page.route(`**/api/meshes/${MESH}/agents/${agent}/transcript?**`, async (route) => {
      const url = new URL(route.request().url());
      const before = url.searchParams.get("before");
      const limit = Number(url.searchParams.get("limit") ?? BACKFILL_LIMIT);
      if (!before) {
        tailRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: seeded.full.slice(-limit), hasMore: true }),
        });
        return;
      }
      backfillRequests += 1;
      const beforeIndex = seeded.full.findIndex((item) => item.id === before);
      const start = Math.max(0, beforeIndex - limit);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: beforeIndex >= 0 ? seeded.full.slice(start, beforeIndex) : [], hasMore: start > 0 }),
      });
    });

    await page.evaluate((state) => {
      (window as any).__meshStore.apply({ t: "snapshot", state });
    }, seeded.state);
    const beforeSwitch = await page.evaluate(({ mesh, agent }) => {
      return (window as any).__meshStore.getState().perMesh[mesh].transcripts[agent].items.length;
    }, { mesh: MESH, agent });
    if (beforeSwitch !== 0) throw new Error(`expected empty snapshot transcript, got ${beforeSwitch}`);

    await page.locator(`.conv-member-tab:has-text("${agent}")`).click();
    await page.waitForFunction(({ mesh, agent, expected }) => {
      return (window as any).__meshStore.getState().perMesh[mesh].transcripts[agent].items.length === expected;
    }, { mesh: MESH, agent, expected: BACKFILL_LIMIT }, { timeout: 5000 });
    const afterInitial = await page.evaluate(({ mesh, agent }) => {
      const tr = (window as any).__meshStore.getState().perMesh[mesh].transcripts[agent];
      return { length: tr.items.length, hasMore: tr.hasMore, oldestSeq: tr.oldestSeq, firstId: tr.items[0].id };
    }, { mesh: MESH, agent });
    if (tailRequests !== 1) throw new Error(`initial tail requests ${tailRequests}`);
    if (afterInitial.length !== BACKFILL_LIMIT) throw new Error(`lazy tail length ${afterInitial.length}`);
    if (afterInitial.hasMore !== true) throw new Error("lazy tail missing hasMore");
    if (afterInitial.oldestSeq !== afterInitial.firstId) throw new Error(`oldestSeq ${afterInitial.oldestSeq} did not match first id ${afterInitial.firstId}`);

    for (const expected of [200, 300]) {
      await page.evaluate(({ mesh, agent }) => (window as any).__meshStore.loadOlderTranscript(mesh, agent), { mesh: MESH, agent });
      await page.waitForFunction(({ mesh, agent, expected }) => {
        return (window as any).__meshStore.getState().perMesh[mesh].transcripts[agent].items.length >= expected;
      }, { mesh: MESH, agent, expected }, { timeout: 5000 });
    }
    const finalState = await page.evaluate(({ mesh, agent }) => {
      const tr = (window as any).__meshStore.getState().perMesh[mesh].transcripts[agent];
      return { length: tr.items.length, hasMore: tr.hasMore, oldestSeq: tr.oldestSeq, firstId: tr.items[0].id };
    }, { mesh: MESH, agent });
    if (finalState.length !== 300) throw new Error(`loaded ${finalState.length} items after backfill`);
    if (finalState.oldestSeq !== seeded.full[SNAPSHOT_TRANSCRIPT_ITEMS - 300].id) throw new Error(`oldestSeq ${finalState.oldestSeq}`);
    metrics.scenarioH = { initial: afterInitial, final: finalState, tailRequests, backfillRequests };
    await page.unroute(`**/api/meshes/${MESH}/agents/${agent}/transcript?**`);
  });

  await step("Scenario I: scrolling a 100-item lazy transcript to top triggers backfill", async () => {
    const agent = "codex-2";
    const seeded = seededLazyInitialState(agent);
    let tailRequests = 0;
    let backfillRequests = 0;
    await page.route(`**/api/meshes/${MESH}/agents/${agent}/transcript?**`, async (route) => {
      const url = new URL(route.request().url());
      const before = url.searchParams.get("before");
      const limit = Number(url.searchParams.get("limit") ?? BACKFILL_LIMIT);
      if (!before) {
        tailRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: seeded.full.slice(-limit), hasMore: true }),
        });
        return;
      }
      backfillRequests += 1;
      const beforeIndex = seeded.full.findIndex((item) => item.id === before);
      const start = Math.max(0, beforeIndex - limit);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: beforeIndex >= 0 ? seeded.full.slice(start, beforeIndex) : [], hasMore: start > 0 }),
      });
    });

    await page.evaluate((state) => {
      (window as any).__meshStore.apply({ t: "snapshot", state });
    }, seeded.state);
    await page.locator(`.conv-member-tab:has-text("${agent}")`).click();
    await page.waitForFunction(({ mesh, agent, expected }) => {
      return (window as any).__meshStore.getState().perMesh[mesh].transcripts[agent].items.length === expected;
    }, { mesh: MESH, agent, expected: BACKFILL_LIMIT }, { timeout: 5000 });
    const stream = await activeStream(page);
    await page.waitForSelector(`.conv-panel [data-item-id="${agent}-backfill-msg-499"]`, { timeout: 5000 });
    await page.waitForTimeout(120);
    await stream.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForFunction(({ mesh, agent, expected }) => {
      return (window as any).__meshStore.getState().perMesh[mesh].transcripts[agent].items.length === expected;
    }, { mesh: MESH, agent, expected: BACKFILL_LIMIT * 2 }, { timeout: 5000 });
    if (tailRequests !== 1) throw new Error(`initial tail requests ${tailRequests}`);
    if (backfillRequests !== 1) throw new Error(`scroll backfill requests ${backfillRequests}`);
    metrics.scenarioI = { tailRequests, backfillRequests };
    await page.unroute(`**/api/meshes/${MESH}/agents/${agent}/transcript?**`);
  });

  await step("Scenario J: live append does not force a scrolled-up transcript to bottom", async () => {
    await page.evaluate((state) => {
      (window as any).__meshStore.apply({ t: "snapshot", state });
    }, seededState());
    await page.locator(".conv-router-tab").click();
    const stream = await activeStream(page);
    await page.waitForSelector(".conv-panel [data-item-id='router-msg-999']", { timeout: 5000 });
    await page.waitForTimeout(300);
    await stream.focus();
    await page.keyboard.press("PageUp");
    await page.locator(".conv-panel .jump-bottom").waitFor({ timeout: 5000 });
    const before = await stream.evaluate((el) => ({
      scrollTop: el.scrollTop,
      distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
    }));
    if (before.scrollTop <= 0) throw new Error(`expected non-zero scrollTop before append, got ${before.scrollTop}`);
    if (before.distanceFromBottom <= 80) throw new Error(`expected to be away from bottom before append, distance=${before.distanceFromBottom}`);

    await page.evaluate(({ mesh }) => {
      (window as any).__meshStore.apply({
        t: "transcript.upsert",
        conv: { scope: "agent", mesh, agent: "router" },
        item: {
          id: "router-live-append-mf6",
          kind: "message",
          role: "agent",
          text: "router live append should not yank scrolled-up transcript to bottom",
          complete: true,
          ts: new Date(Date.UTC(2026, 5, 9, 2, 0, 0)).toISOString(),
        },
      });
    }, { mesh: MESH });
    await page.waitForFunction(({ mesh }) => {
      return (window as any).__meshStore.getState().perMesh[mesh].transcripts.router.items.some((item: TranscriptItem) => item.id === "router-live-append-mf6");
    }, { mesh: MESH }, { timeout: 5000 });
    await page.waitForTimeout(180);
    const after = await stream.evaluate((el) => ({
      scrollTop: el.scrollTop,
      distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
    }));
    if (after.distanceFromBottom <= 80) throw new Error(`live append forced transcript to bottom: before=${before.distanceFromBottom}, after=${after.distanceFromBottom}`);
    metrics.scenarioJ = { before, after };
  });

  await step("no console/page errors", async () => {
    if (errors.length) throw new Error(errors.slice(0, 2).join(" || "));
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  console.log(`  metrics ${JSON.stringify(metrics)}`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  CHAT VIRTUALIZATION E2E OK");
  }
} finally {
  await browser.close();
  server.kill();
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
