// Chat virtualization stress e2e. Seeds a synthetic 5-agent mesh with 1000
// transcript items per agent and verifies detail/canvas rendering stays bounded.
// Run: bun run src/web/chat-virtualization.e2e.ts
import { type Locator, type Page } from "playwright";
import { launchChromium, e2eEnv } from "./e2e-playwright";
import type { GatewayState, MeshSummary, PerMeshState, TranscriptItem } from "./types";

const PORT = Number(process.env.E2E_PORT) || 15089;
const BASE = `http://localhost:${PORT}`;
const MESH = "virtual-stress";
const AGENTS = ["router", "codex-1", "codex-2", "opencode-1", "reviewer"];
const ITEMS_PER_AGENT = 1000;
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
      if ((await fetch(`${BASE}/api/state`)).ok) return;
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
    transcripts: Object.fromEntries(AGENTS.map((agent) => [agent, transcript(agent)])),
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

const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT)], {
  stdout: "pipe",
  stderr: "pipe",
  env: e2eEnv(),
});
const browser = await launchChromium();

try {
  await waitReady();
  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".brand", { timeout: 8000 });
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
      await stream.evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
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
}
