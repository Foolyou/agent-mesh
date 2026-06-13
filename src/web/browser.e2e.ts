// Headless browser end-to-end over the `--fake` server: spawns the server, drives the
// real DOM with Playwright (bundled chromium), and asserts every widget. Also writes
// screenshots to /tmp/mesh-shots. Run: bun run src/web/browser.e2e.ts
import { type Page } from "playwright";
import { launchChromium, e2eEnv } from "./e2e-playwright";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.E2E_PORT) || 7413;
const BASE = `http://localhost:${PORT}`;
const SHOTS = "/tmp/mesh-shots";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

mkdirSync(SHOTS, { recursive: true });

let pass = 0;
const fails: string[] = [];
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

// Screenshots are diagnostics, not assertions — a hung capture must not kill the run.
async function shot(page: Page, name: string) {
  try {
    await page.screenshot({ path: `${SHOTS}/${name}`, fullPage: true, timeout: 10_000 });
  } catch (e: any) {
    console.log(`  ⚠ screenshot ${name} skipped — ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/state`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("server never became ready");
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
  // ignore HTTP-status resource logs (e.g. the deliberate 400 in the toast test —
  // the app surfaces those as toasts); keep genuine JS/React errors.
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/api/harnesses/*/models**", (route) => {
    const harness = route.request().url().match(/\/api\/harnesses\/([^/]+)\/models/)?.[1] ?? "unknown";
    const models: Record<string, Array<{ id: string; name: string }>> = {
      claude: [
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
        { id: "claude-opus-4.1", name: "Claude Opus 4.1" },
      ],
      codex: [
        { id: "gpt-5.4", name: "GPT 5.4" },
        { id: "gpt-5.5", name: "GPT 5.5" },
      ],
      opencode: [
        { id: "kimi-k2", name: "kimi-k2" },
        { id: "deepseek-v3", name: "deepseek-v3" },
      ],
      kimi: [],
    };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ models: models[harness] ?? [], probedAt: 1234 }),
    });
  });
  await page.route("**/api/harnesses", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { id: "codex", label: "Codex", installed: true, auth: "ok", installable: "npm", runningAgentsUsingOldVersion: [] },
        { id: "claude", label: "Claude", installed: true, auth: "ok", installable: "npm", runningAgentsUsingOldVersion: [] },
        { id: "opencode", label: "OpenCode", installed: true, auth: "ok", installable: "self", runningAgentsUsingOldVersion: [] },
        { id: "kimi", label: "Kimi", installed: false, auth: "unknown", installable: "self", runningAgentsUsingOldVersion: [] },
      ]),
    }),
  );

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  await step("topbar + ws live + demo mesh listed", async () => {
    await page.waitForSelector(".brand", { timeout: 8000 });
    await page.waitForSelector('.stat:has-text("live")', { timeout: 8000 });
    await page.waitForSelector('.mrow:has-text("demo")', { timeout: 8000 });
  });

  await step("mesh auto-selected → detail header shows start button", async () => {
    await page.waitForSelector('.detail-head:has-text("demo")', { timeout: 8000 });
    await page.waitForSelector('.detail-head .btn:has-text("start mesh")', { timeout: 8000 });
  });

  await step("topology renders 3 nodes + edges", async () => {
    await page.waitForSelector(".topo svg .node", { timeout: 8000 });
    const nodes = await page.locator(".topo .node").count();
    if (nodes !== 3) throw new Error(`expected 3 nodes, got ${nodes}`);
    const edges = await page.locator(".topo .edge").count();
    if (edges < 1) throw new Error("no topology edges");
    const curve = await page.locator(".topo svg").evaluate((svg) => {
      const edge = svg.querySelector('.edge[data-from="codex-1"][data-to="opencode-1"]') as SVGPathElement | null;
      const reverse = svg.querySelector('.edge[data-from="opencode-1"][data-to="codex-1"]') as SVGPathElement | null;
      const router = [...svg.querySelectorAll(".node")].find((n) => n.textContent?.includes("router")) as SVGGElement | undefined;
      if (!edge || !reverse || !router) return null;
      const mid = edge.getPointAtLength(edge.getTotalLength() / 2);
      const reverseMid = reverse.getPointAtLength(reverse.getTotalLength() / 2);
      const ctm = edge.getScreenCTM();
      if (!ctm) return null;
      const screenMid = new DOMPoint(mid.x, mid.y).matrixTransform(ctm);
      const screenReverseMid = new DOMPoint(reverseMid.x, reverseMid.y).matrixTransform(ctm);
      const routerBox = router.getBoundingClientRect();
      const outsideRouter =
        screenMid.x < routerBox.left - 4 ||
        screenMid.x > routerBox.right + 4 ||
        screenMid.y < routerBox.top - 4 ||
        screenMid.y > routerBox.bottom + 4;
      return {
        d: edge.getAttribute("d") ?? "",
        reverseD: reverse.getAttribute("d") ?? "",
        midX: screenMid.x,
        reverseMidX: screenReverseMid.x,
        outsideRouter,
      };
    });
    if (!curve) throw new Error("missing member-to-member topology edge paths");
    if (!curve.d.includes(" Q ") || !curve.reverseD.includes(" Q ")) throw new Error(`member edges were not curved: ${curve.d} / ${curve.reverseD}`);
    if (!curve.outsideRouter) throw new Error(`member edge still crosses the router node at midpoint x=${curve.midX}`);
    if (Math.abs(curve.midX - curve.reverseMidX) < 40) {
      throw new Error(`bidirectional member edges were not visually separated: ${curve.midX} vs ${curve.reverseMidX}`);
    }
    const box = await page.locator(".topo svg").boundingBox();
    if (!box || box.height < 120) throw new Error(`topology svg too short (${box?.height}px) — graph cropped`);
  });

  await shot(page, "01-loaded.png");

  await step("start mesh → status running, agents ready", async () => {
    await page.locator('.detail-head .btn:has-text("start mesh")').click();
    await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });
  });

  await step("running topology can add a mail edge", async () => {
    const topologyPanel = page.locator(".drail .panel", { has: page.locator('.head .ttl:text-is("topology")') }).first();
    await topologyPanel.locator('.topology-manage-toggle .btn[aria-label="manage topology"]').click();
    await topologyPanel.locator(".topology-controls.open .edge-add select").first().waitFor({ timeout: 5000 });
    const edgeAdd = topologyPanel.locator(".topology-controls.open .edge-add").first();
    await edgeAdd.locator("select").nth(0).selectOption("codex-1");
    await edgeAdd.locator("select").nth(1).selectOption("router");
    await edgeAdd.locator('.btn:has-text("+ edge")').click();
    await page.waitForSelector('.topo .edge[data-from="codex-1"][data-to="router"]', { timeout: 5000 });
  });

  await step("running topology can add a cold lazy agent", async () => {
    const topologyPanel = page.locator(".drail .panel", { has: page.locator('.head .ttl:text-is("topology")') }).first();
    await topologyPanel.locator(".topology-controls.open .agent-add input").waitFor({ timeout: 5000 });
    const add = topologyPanel.locator(".topology-controls.open .agent-add").first();
    await add.locator("input").fill("newbie");
    await add.locator("select").selectOption("codex");
    await add.locator('.btn:has-text("+ agent")').click();
    await page.waitForSelector('.topo .node[data-agent="newbie"]', { timeout: 5000 });
    await page.locator('.conv-member-tab:has-text("newbie")').click();
    await page.waitForSelector('.conv-panel:has-text("newbie") .dot.cold', { timeout: 5000 });
    await page.waitForSelector('.conv-panel .btn:has-text("start")', { timeout: 5000 });
    await page.locator(".conv-router-tab").click();
  });

  await step("unified conversation tabs pin router with status dot and switch conversations", async () => {
    const panel = page.locator(".conv-panel").first();
    await panel.waitFor({ timeout: 8000 });
    const chatBox = await page.locator(".dchat").first().boundingBox();
    const panelBox = await panel.boundingBox();
    if (!chatBox || !panelBox) throw new Error("conversation panel/chat geometry missing");
    if (panelBox.width < chatBox.width - 2) {
      throw new Error(`conversation panel did not fill chat column (${panelBox.width}px < ${chatBox.width}px)`);
    }
    const title = ((await panel.locator(".head .ttl").first().textContent()) ?? "").trim().toLowerCase();
    if (title !== "conversation") throw new Error(`conversation panel title was "${title}"`);
    const routerTab = panel.locator(".conv-router-tab");
    await routerTab.waitFor({ timeout: 4000 });
    if ((await routerTab.locator(".dot.ready, .dot.running").count()) < 1) throw new Error("router tab missing live status dot");
    const rbox = await routerTab.boundingBox();
    const stripBox = await panel.locator(".conv-member-strip").boundingBox();
    if (!rbox || !stripBox || rbox.x >= stripBox.x) throw new Error("router tab is not pinned left of member strip");
    const routerStyle = await routerTab.evaluate((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      return { backgroundColor: cs.backgroundColor, boxShadow: cs.boxShadow };
    });
    if (routerStyle.backgroundColor !== "rgba(0, 0, 0, 0)") {
      throw new Error(`router tab should use transparent member-tab background, got ${routerStyle.backgroundColor}`);
    }
    if (routerStyle.boxShadow !== "none") throw new Error(`router tab should not have inset shadow, got ${routerStyle.boxShadow}`);

    const assertSelectedTab = async (selector: string, label: string) => {
      const style = await panel.locator(selector).first().evaluate((el) => {
        const cs = getComputedStyle(el as HTMLElement);
        return { borderBottomColor: cs.borderBottomColor, borderBottomWidth: cs.borderBottomWidth, color: cs.color };
      });
      if (style.borderBottomWidth !== "2px") throw new Error(`${label} selected border width was ${style.borderBottomWidth}`);
      if (style.borderBottomColor === "transparent" || style.borderBottomColor === "rgba(0, 0, 0, 0)") {
        throw new Error(`${label} selected border was transparent`);
      }
    };
    await assertSelectedTab(".conv-router-tab.sel", "router tab");

    await panel.locator('.conv-member-tab:has-text("codex-1")').click();
    await panel.locator('.composer textarea[placeholder*="codex-1"]').waitFor({ timeout: 4000 });
    await panel.locator(".conv-control .sub", { hasText: "codex" }).waitFor({ timeout: 4000 });
    await assertSelectedTab('.conv-member-tab.sel:has-text("codex-1")', "member tab");
    await routerTab.click();
    await panel.locator('.composer textarea[placeholder*="router"]').waitFor({ timeout: 4000 });
    await panel.locator(".conv-control .sub", { hasText: "claude" }).waitFor({ timeout: 4000 });
    await assertSelectedTab(".conv-router-tab.sel", "router tab");
  });

  await step("conversation queue box shows count and latest preview above composer", async () => {
    await page.evaluate(() => {
      (window as any).__meshStore.apply({
        t: "agent.queue",
        name: "demo",
        agent: "router",
        summary: { count: 2, latestPreview: "you: queued preview should stay on one line" },
      });
    });
    const panel = page.locator(".conv-panel").first();
    const box = panel.locator(".queue-box");
    await box.waitFor({ timeout: 4000 });
    await box.locator(".queue-count", { hasText: "queued: 1/2" }).waitFor({ timeout: 4000 });
    await box.locator(".queue-source", { hasText: "you" }).waitFor({ timeout: 4000 });
    await box.locator(".queue-preview", { hasText: "queued preview should stay on one line" }).waitFor({ timeout: 4000 });
    if (await box.locator(".queue-preview", { hasText: "you:" }).count()) throw new Error("queue preview repeated the source label");
    const queueBox = await box.boundingBox();
    const composerBox = await panel.locator(".composer").boundingBox();
    if (!queueBox || !composerBox || queueBox.y >= composerBox.y) throw new Error("queue box is not above composer");
    await page.evaluate(() => {
      (window as any).__meshStore.apply({
        t: "agent.queue",
        name: "demo",
        agent: "router",
        summary: { count: 0 },
      });
    });
    await box.waitFor({ state: "detached", timeout: 4000 });
  });

  await step("conversation member strip scrolls without visible scrollbar and overflow menu jumps", async () => {
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      const state = store.getState();
      const demo = state.meshes.find((m: any) => m.name === "demo");
      if (!demo || demo.agents.some((a: any) => a.id === "extra-7")) return;
      const extras = Array.from({ length: 8 }, (_, i) => ({
        id: `extra-${i}`,
        harness: i % 2 ? "claude" : "codex",
        role: "member",
        status: "ready",
        activity: "idle",
      }));
      store.apply({ t: "mesh.list", meshes: state.meshes.map((m: any) => (m.name === "demo" ? { ...m, agents: [...m.agents, ...extras] } : m)) });
      for (const a of extras) {
        store.apply({
          t: "transcript.upsert",
          conv: { scope: "agent", mesh: "demo", agent: a.id },
          item: { id: `${a.id}-msg`, kind: "message", role: "agent", text: `hello from ${a.id}`, ts: new Date().toISOString(), complete: true },
        });
      }
    });
    const strip = page.locator(".conv-member-strip").first();
    await strip.locator('.conv-member-tab:has-text("extra-7")').waitFor({ timeout: 4000 });
    const metrics = await strip.evaluate((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      return {
        overflowX: cs.overflowX,
        scrollable: el.scrollWidth > el.clientWidth,
        hiddenScrollbar: cs.scrollbarWidth === "none",
      };
    });
    if (metrics.overflowX !== "auto") throw new Error(`member strip overflow-x was ${metrics.overflowX}`);
    if (!metrics.scrollable) throw new Error("member strip was not horizontally scrollable after member injection");
    if (!metrics.hiddenScrollbar) throw new Error("member strip scrollbar was not hidden");

    const button = page.locator(".conv-overflow-btn").first();
    await button.click();
    const menu = page.locator(".conv-overflow-menu");
    await menu.waitFor({ timeout: 4000 });
    const count = await menu.locator(".conv-overflow-item").count();
    if (count < 10) throw new Error(`overflow menu did not list all members, got ${count}`);
    await menu.locator('.conv-overflow-item:has-text("extra-7")').click();
    await page.locator('.composer textarea[placeholder*="extra-7"]').waitFor({ timeout: 4000 });
    const activeVisible = await page.locator('.conv-member-tab.sel:has-text("extra-7")').isVisible();
    if (!activeVisible) throw new Error("overflow selection did not activate and scroll to extra-7 tab");
    await page.locator(".conv-router-tab").click();
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      const state = store.getState();
      store.apply({
        t: "mesh.list",
        meshes: state.meshes.map((m: any) => (m.name === "demo" ? { ...m, agents: m.agents.filter((a: any) => !String(a.id).startsWith("extra-")) } : m)),
      });
    });
  });

  await step("router message is COALESCED into one growing bubble (not per-chunk)", async () => {
    // the fake streams 'Plan: codex-1 implements the calculator core, opencode-1 reviews.'
    const panel = page.locator(".conv-panel").first();
    const bubble = panel.locator(".msg.agent .bubble", {
      hasText: "implements the calculator core",
    });
    await bubble.first().waitFor({ timeout: 10000 });
    const count = await panel.locator(".msg.agent").count();
    if (count > 3) throw new Error(`too many message bubbles (${count}) — chunks not coalesced`);
  });

  await step("agent prose renders markdown live", async () => {
    const panel = page.locator(".conv-panel").first();
    const bubble = panel.locator(".msg.agent .bubble", { hasText: "implements the calculator core" }).first();
    await bubble.locator("strong", { hasText: "codex-1" }).waitFor({ timeout: 4000 });
    await bubble.locator("ul li", { hasText: "implement core" }).waitFor({ timeout: 4000 });
    await bubble.locator("pre code", { hasText: "export const add" }).waitFor({ timeout: 4000 });
    const link = bubble.locator('a[href^="https://example.com"]').first();
    await link.waitFor({ timeout: 4000 });
    const href = await link.getAttribute("href");
    const target = await link.getAttribute("target");
    const rel = await link.getAttribute("rel");
    if (href !== "https://example.com" && href !== "https://example.com/") throw new Error(`safe link href was ${href}`);
    if (target !== "_blank") throw new Error(`safe link target was ${target}`);
    if (rel !== "noopener noreferrer") throw new Error(`safe link rel was ${rel}`);
    const badLinks = await bubble.locator('a[href^="javascript:"]').count();
    if (badLinks) throw new Error("javascript link retained an anchor href");
    const img = bubble.locator("img").first();
    await img.waitFor({ timeout: 4000 });
    if ((await img.getAttribute("referrerpolicy")) !== "no-referrer") throw new Error("image referrerpolicy not hardened");
    if ((await img.getAttribute("loading")) !== "lazy") throw new Error("image loading not lazy");
    const badImages = await bubble.locator('img[src^="javascript:"]').count();
    if (badImages) throw new Error("javascript image src rendered");
    // data:image/png is a spec-allowed scheme and must survive sanitize …
    const dataImg = bubble.locator('img[src^="data:image/png"]');
    if ((await dataImg.count()) < 1) throw new Error("data:image/png did not render (sanitize stripped it)");
    // … but data:image/svg+xml (can carry script) must be blocked …
    if ((await bubble.locator('img[src^="data:image/svg"]').count()) > 0) throw new Error("data:image/svg+xml rendered");
    // … and raw HTML must not pass through as a live element (no rehype-raw)
    if ((await bubble.locator("u").count()) > 0) throw new Error("raw HTML <u> rendered as a live element");
  });

  await step("router shows a plan checklist", async () => {
    await page.locator(".conv-panel .plan .plan-row").first().waitFor({ timeout: 9000 });
  });

  await step("agent replies never render a streaming caret", async () => {
    // The UI intentionally renders no caret, including while replies are still streaming.
    await page.waitForFunction(
      () => {
        const panel = document.querySelector(".conv-panel");
        const agentMsgs = panel?.querySelectorAll(".msg.agent") ?? [];
        return agentMsgs.length > 0 && document.querySelectorAll(".cursor").length === 0;
      },
      { timeout: 10000 },
    );
  });

  await step("messages show timestamps", async () => {
    const t = await page.locator(".msg .who .t").first().textContent();
    if (!/\d\d:\d\d:\d\d/.test(t ?? "")) throw new Error(`no timestamp (got "${t}")`);
  });

  await step("thought block present and expandable", async () => {
    const label = page.locator(".thought .label").first();
    await label.waitFor({ timeout: 8000 });
    await label.click();
    await page.waitForSelector(".thought .txt", { timeout: 4000 });
    await page.waitForSelector(".thought .txt strong", { timeout: 4000 });
  });

  await step("tool-call card defaults collapsed; toggle expands and collapses", async () => {
    // switch to codex-1 agent panel via topology node click
    await page.locator('.topo .node:has-text("codex-1")').click();
    await page.waitForSelector('.tool .badge.completed', { timeout: 12000 });
    const cards = await page.locator(".tool").count();
    if (cards < 1) throw new Error("no tool card");
    const detailed = page.locator(".tool", { has: page.locator(".kbd") }).first();
    await detailed.waitFor({ timeout: 4000 });
    const defaultDetails = await detailed.locator(".tdetail").count();
    if (defaultDetails) throw new Error("tool detail was visible before expansion");
    // detail appears after clicking a detail-bearing card
    await detailed.locator(".thead").click();
    await detailed.locator(".tdetail").waitFor({ timeout: 4000 });
    await detailed.locator(".tout").first().waitFor({ timeout: 4000 });
    await page.waitForSelector('.tool .tdetail .tlabel:has-text("input")', { timeout: 4000 });
    const strongInTool = await page.locator(".tool .tout strong").count();
    if (strongInTool) throw new Error("tool detail rendered markdown");
    const raw = await page.locator(".tool .tout", { hasText: "**raw output**" }).count();
    if (!raw) throw new Error("tool output did not preserve raw markdown text");
    // the manual toggle collapses the expanded detail-bearing card
    await detailed.locator(".thead").click();
    await detailed.locator(".tdetail").waitFor({ state: "detached", timeout: 4000 });
  });

  await step("tool cards keep full height when the transcript overflows (no flex-shrink collapse)", async () => {
    await page.locator(".conv-router-tab").click();
    // Regression: .stream is a flex column; an overflowing transcript used to let flexbox
    // shrink .tool cards (overflow:hidden → flex min-size 0) down to their ~2px borders.
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      const now = new Date().toISOString();
      const conv = { scope: "agent", mesh: "demo", agent: "router" };
      for (let i = 0; i < 14; i++) {
        store.apply({
          t: "transcript.upsert",
          conv,
          item: { id: `of-${i}`, kind: "message", role: "agent", text: Array.from({ length: 6 }, (_, j) => `overflow filler ${i}.${j}`).join("\n"), ts: now, complete: true },
        });
      }
      store.apply({
        t: "transcript.upsert",
        conv,
        item: { id: "of-tool", kind: "tool_call", toolCallId: "of-tc", title: "mcp__mesh__send_mail", toolKind: "other", status: "completed", input: '{ "to": "impl", "body": "hi" }', ts: now, updatedTs: now },
      });
    });
    const panel = page.locator(".conv-panel").first();
    const card = panel.locator(".tool", { hasText: "mcp__mesh__send_mail" }).first();
    await card.waitFor({ timeout: 4000 });
    const h = await card.evaluate((el) => (el as HTMLElement).offsetHeight);
    if (h < 24) throw new Error(`tool card collapsed to ${h}px under overflow (flex-shrink regression)`);
  });

  await step("codex thinking effort is read-only while the mesh is running", async () => {
    // Codex effort is still spawn-time only; Claude/Kimi can switch runtime thought level.
    // The create/edit builder test covers the stopped-edit + persist round-trip.
    await page.locator('.topo .node:has-text("codex-1")').click();
    const sel = page.locator('.dchat .panel:has(.tabs) .effort-sel').first();
    await sel.waitFor({ timeout: 6000 });
    if (!(await sel.isDisabled())) throw new Error("codex effort select should be read-only (disabled) while running");
  });

  await step("failed command surfaces an error toast", async () => {
    // starting an already-running mesh fails → toast (drives the store directly)
    await page.evaluate(() => (window as any).__meshStore.startMesh("demo").catch(() => {}));
    await page.waitForSelector(".toast.error", { timeout: 4000 });
  });

  await step("rail logs: mailbox tab shows inter-agent mail", async () => {
    await page.locator('.drail .seg-tab:has-text("mail")').click();
    await page.waitForSelector(".drail .panel .k.mail", { timeout: 10000 });
  });

  await step("received mail appears inline in the recipient's conversation, sender-labeled", async () => {
    // the fake mails codex-1 → opencode-1; open opencode-1 and verify the inline mail bubble
    await page.locator('.topo .node:has-text("opencode-1")').click();
    const mail = page.locator(".msg.mail", { hasText: "core implemented" }).first();
    await mail.waitFor({ timeout: 10000 });
    // Use textContent instead of innerText because .stream > * has content-visibility: auto,
    // which can cause innerText to return "" for elements Playwright evaluates before layout.
    const who = ((await mail.locator(".who").textContent()) ?? "").toLowerCase();
    if (!who.includes("codex-1")) throw new Error(`mail bubble missing sender label: ${who}`);
  });

  await step("rail logs: activity tab shows mail + interrupt + log", async () => {
    await page.locator('.drail .seg-tab:has-text("activity")').click();
    await page.waitForSelector(".drail .panel .k.interrupt", { timeout: 10000 });
  });

  await step("permission card (pinned) appears and resolves into history", async () => {
    const card = page.locator(".dperm .perm");
    await card.first().waitFor({ timeout: 12000 });
    await shot(page, "02-running.png");
    await page.locator('.dperm .perm .btn:has-text("Allow once")').click();
    await page.locator('.drail .seg-tab:has-text("history")').click();
    await page.waitForSelector(".drail .panel .k.permission_resolved", { timeout: 6000 });
    if ((await page.locator(".dperm .perm").count()) !== 0) throw new Error("permission card did not clear");
  });

  await step("operator interrupt cancels an agent's turn (activity from 'operator')", async () => {
    await page.evaluate(() => (window as any).__meshStore.apply({ t: "agent.activity", name: "demo", agent: "codex-1", activity: "working" }));
    await page.locator('.topo .node:has-text("codex-1")').click();
    const panel = page.locator(".dchat .panel:has(.tabs)").first();
    await panel.locator(".conv-control .btn", { hasText: "interrupt" }).waitFor({ state: "detached", timeout: 1000 }).catch(() => {});
    await panel.locator(".composer .compose-interrupt", { hasText: "interrupt" }).click();
    await page.locator('.drail .seg-tab:has-text("activity")').click();
    await page.waitForSelector('.drail .panel .tx:has-text("operator")', { timeout: 6000 });
  });

  await step("assistant chat: send instruction → user bubble + streamed reply", async () => {
    const input = page.locator('.panel:has(.head:has-text("Mesh Assistant")) .composer textarea');
    await input.fill("create a build squad mesh");
    await input.press("Enter");
    await page.waitForSelector('.panel:has(.head:has-text("Mesh Assistant")) .msg.user', { timeout: 6000 });
    await page.waitForSelector('.panel:has(.head:has-text("Mesh Assistant")) .msg.agent', { timeout: 8000 });
  });

  await step("assistant chat fullscreens on desktop and exits via button without hiding composer", async () => {
    const panel = page.locator(".assistant-chat");
    const toggle = panel.locator('button[aria-label*="Mesh Assistant"]');
    await toggle.click();
    await panel.evaluate((el) => {
      const box = (el as HTMLElement).getBoundingClientRect();
      if (box.left > 1 || box.top > 1 || Math.abs(box.width - window.innerWidth) > 2 || Math.abs(box.height - window.innerHeight) > 2) {
        throw new Error(`assistant chat was not fullscreen: ${box.left},${box.top},${box.width}x${box.height}`);
      }
    });
    await panel.locator(".composer textarea").waitFor({ timeout: 4000 });
    await toggle.click();
    await page.waitForFunction(() => !document.querySelector(".assistant-chat")?.classList.contains("assistant-full"), { timeout: 4000 });
  });

  await step("assistant chat fullscreens on mobile and exits via button without hiding composer", async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    const back = page.locator('.topbar .btn:has-text("back")');
    await back.waitFor({ timeout: 4000 }).then(() => back.click()).catch(() => {});
    const panel = page.locator(".assistant-chat");
    const toggle = panel.locator('button[aria-label*="Mesh Assistant"]');
    await toggle.click();
    await panel.evaluate((el) => {
      const box = (el as HTMLElement).getBoundingClientRect();
      if (box.left > 1 || box.top > 1 || Math.abs(box.width - window.innerWidth) > 2 || Math.abs(box.height - window.innerHeight) > 2) {
        throw new Error(`mobile assistant chat was not fullscreen: ${box.left},${box.top},${box.width}x${box.height}`);
      }
    });
    await panel.locator(".composer textarea").waitFor({ timeout: 4000 });
    await toggle.click();
    await page.waitForFunction(() => !document.querySelector(".assistant-chat")?.classList.contains("assistant-full"), { timeout: 4000 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.mrow:has-text("demo")').click();
  });

  await step("router chat: send prompt → user bubble renders markdown", async () => {
    await page.locator(".conv-router-tab").click();
    const panel = page.locator(".conv-panel").first();
    const input = panel.locator(".composer textarea");
    await input.fill("status **please**");
    await input.press("Enter");
    await panel.locator(".msg.user").last().waitFor({ timeout: 6000 });
    const focused = await input.evaluate((el) => el === document.activeElement);
    if (!focused) throw new Error("composer textarea did not regain focus after send");
    const user = panel.locator(".msg.user .bubble", { hasText: "status please" }).last();
    await user.waitFor({ timeout: 4000 });
    if ((await user.locator("strong").count()) < 1) throw new Error("user message did not render markdown");
  });

  await step("compact event renders context compacted marker", async () => {
    await page.locator(".conv-router-tab").click();
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      store.apply({
        t: "transcript.upsert",
        conv: { scope: "agent", mesh: "demo", agent: "router" },
        item: { id: "compact-e2e", kind: "compact", status: "completed", reason: "auto-threshold", ts: new Date().toISOString() },
      });
    });
    await page.locator(".conv-panel .compact-entry", { hasText: "--- Context Compacted ---" }).waitFor({ timeout: 4000 });
  });

  await step("unclosed fence streams without breaking and resolves when closed", async () => {
    await page.locator(".conv-router-tab").click();
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      const now = new Date().toISOString();
      store.apply({
        t: "transcript.upsert",
        conv: { scope: "agent", mesh: "demo", agent: "router" },
        item: { id: "md-stream", kind: "message", role: "agent", text: "Before\n```ts\nconst x = 1", ts: now, complete: false },
      });
    });
    const panel = page.locator(".conv-panel").first();
    await panel.locator("#md-stream").waitFor({ timeout: 4000 }).catch(() => {});
    await panel.locator(".msg.agent .bubble", { hasText: "Before" }).last().waitFor({ timeout: 4000 });
    await panel.locator(".msg.agent .bubble pre, .msg.agent .bubble code", { hasText: "const x = 1" }).last().waitFor({ timeout: 4000 });
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      store.apply({
        t: "transcript.patch",
        conv: { scope: "agent", mesh: "demo", agent: "router" },
        id: "md-stream",
        patch: { text: "Before\n```ts\nconst x = 1\n```\nAfter", complete: true },
      });
    });
    await panel.locator(".msg.agent .bubble pre code", { hasText: "const x = 1" }).last().waitFor({ timeout: 4000 });
    await panel.locator(".msg.agent .bubble", { hasText: "After" }).last().waitFor({ timeout: 4000 });
  });

  await step("markdown height changes keep transcript pinned to bottom", async () => {
    await page.locator(".conv-router-tab").click();
    const stream = page.locator(".conv-panel .stream").first();
    await stream.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      const now = new Date().toISOString();
      store.apply({
        t: "transcript.upsert",
        conv: { scope: "agent", mesh: "demo", agent: "router" },
        item: { id: "md-tall", kind: "message", role: "agent", text: "short", ts: now, complete: false },
      });
    });
    await sleep(80);
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      store.apply({
        t: "transcript.patch",
        conv: { scope: "agent", mesh: "demo", agent: "router" },
        id: "md-tall",
        patch: { text: Array.from({ length: 24 }, (_, i) => `- row ${i}`).join("\n") },
      });
    });
    await sleep(200);
    const gap = await stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    if (gap >= 40) throw new Error(`stream not pinned after markdown height change, gap=${gap}`);
  });

  await step("global keyboard shortcuts are disabled", async () => {
    await page.locator(".detail-head .mtitle").click(); // focus a non-input element
    await page.keyboard.press("f");
    if (await page.locator(".dmain.full").count()) throw new Error("f key still toggled router fullscreen");
    await page.keyboard.press("Escape");
    await page.locator(".detail").waitFor({ timeout: 4000 });
    await page.keyboard.press("n");
    if (await page.locator(".modal").count()) throw new Error("n key still opened the new mesh modal");
  });

  await step("mesh canvas opens from topology with draggable, resizable agent windows and directed edges", async () => {
    await page.locator('.drail .panel:has(.head:has-text("topology")) .btn:has-text("⤢")').click();
    const canvas = page.locator(".mesh-canvas");
    await canvas.waitFor({ timeout: 5000 });
    const windows = canvas.locator(".canvas-window");
    const agentIds = await page.evaluate(() => (window as any).__meshStore.getState().meshes.find((m: any) => m.name === "demo").agents.map((a: any) => a.id));
    if ((await windows.count()) !== agentIds.length) throw new Error(`expected ${agentIds.length} mesh agent windows, got ${await windows.count()}`);
    for (const id of agentIds) {
      if ((await canvas.locator(`.canvas-window[data-agent="${id}"]`).count()) !== 1) throw new Error(`missing canvas window for ${id}`);
    }
    if (await canvas.locator('.canvas-window:has-text("Mesh Assistant")').count()) throw new Error("assistant appeared on mesh canvas");
    await canvas.locator('.canvas-window[data-agent="router"] .canvas-window-head .pin').waitFor({ timeout: 4000 });
    await canvas.locator('.canvas-window[data-agent="codex-1"] .composer textarea[placeholder*="codex-1"]').waitFor({ timeout: 4000 });

    const edgeCount = await canvas.locator(".canvas-edge").count();
    if (edgeCount < 4) throw new Error(`expected directed mail edges, got ${edgeCount}`);
    if ((await canvas.locator('.canvas-edge[data-from="codex-1"][data-to="opencode-1"]').count()) !== 1) throw new Error("missing codex-1 → opencode-1 edge");
    if ((await canvas.locator('.canvas-edge[data-from="opencode-1"][data-to="codex-1"]').count()) !== 1) throw new Error("missing opencode-1 → codex-1 edge");
    const marker = await canvas.locator('.canvas-edge[data-from="codex-1"][data-to="opencode-1"]').getAttribute("marker-end");
    if (!marker?.includes("canvas-arrow")) throw new Error(`directed edge missing arrowhead marker: ${marker}`);

    await canvas.locator('.canvas-actions .btn[aria-label="actions"]').click();
    const menu = canvas.locator(".canvas-actions .detail-overflow-menu");
    await menu.waitFor({ timeout: 4000 });
    await menu.locator('.btn:has-text("new sessions")').waitFor({ timeout: 4000 });
    await menu.locator('.btn:has-text("stop mesh")').waitFor({ timeout: 4000 });
    await canvas.locator('.canvas-window[data-agent="router"] .canvas-window-head .btn:has-text("stop")').waitFor({ timeout: 4000 });
    await page.mouse.click(20, 70);
    await menu.waitFor({ state: "detached", timeout: 4000 });

    const lifecycle = canvas.locator('.canvas-window[data-agent="codex-1"] .canvas-window-head');
    await lifecycle.locator('.btn:has-text("stop")').click();
    await lifecycle.locator('.btn:has-text("start")').waitFor({ timeout: 4000 });
    await lifecycle.locator('.btn:has-text("start")').click();
    await lifecycle.locator('.btn:has-text("starting")').waitFor({ timeout: 4000 });
    await lifecycle.locator('.btn:has-text("stop")').waitFor({ timeout: 5000 });

    const win = canvas.locator('.canvas-window[data-agent="codex-1"]');
    const before = await win.boundingBox();
    if (!before) throw new Error("codex-1 window missing box");
    await win.locator(".canvas-window-head").dragTo(canvas, { targetPosition: { x: before.x + 120, y: before.y + 80 } });
    const moved = await win.boundingBox();
    if (!moved || Math.abs(moved.x - before.x) < 20 || Math.abs(moved.y - before.y) < 20) throw new Error("canvas window did not move after drag");

    const otherZ = Number(await canvas.locator('.canvas-window[data-agent="router"]').evaluate((el) => getComputedStyle(el as HTMLElement).zIndex));
    const movedZ = Number(await win.evaluate((el) => getComputedStyle(el as HTMLElement).zIndex));
    if (movedZ <= otherZ) throw new Error(`dragged window did not rise above router (${movedZ} <= ${otherZ})`);

    const grip = win.locator(".canvas-resize-grip");
    await grip.dragTo(canvas, { targetPosition: { x: moved.x + moved.width + 90, y: moved.y + moved.height + 60 } });
    const resized = await win.boundingBox();
    if (!resized || resized.width <= moved.width + 20 || resized.height <= moved.height + 20) throw new Error("canvas window did not resize");

    await shot(page, "05-canvas.png");
    await canvas.locator(".canvas-close").click();
    await canvas.waitFor({ state: "detached", timeout: 4000 });
  });

  await step("mesh canvas mail flashes only the matching directed edge then cools down", async () => {
    await page.locator('.drail .panel:has(.head:has-text("topology")) .btn:has-text("⤢")').click();
    const canvas = page.locator(".mesh-canvas");
    await canvas.waitFor({ timeout: 5000 });
    const edge = canvas.locator('.canvas-edge[data-from="codex-1"][data-to="opencode-1"]');
    const reverse = canvas.locator('.canvas-edge[data-from="opencode-1"][data-to="codex-1"]');
    await edge.waitFor({ timeout: 4000 });
    if (await edge.evaluate((el) => el.classList.contains("active"))) throw new Error("edge was active before a new mail event");

    await page.evaluate(() => {
      const now = new Date().toISOString();
      (window as any).__meshStore.apply({
        t: "mail",
        name: "demo",
        entry: { id: `canvas-flash-${Date.now()}`, ts: now, from: "codex-1", to: "opencode-1", body: "flash this directed edge" },
      });
    });
    await page.waitForFunction(() => document.querySelector('.canvas-edge[data-from="codex-1"][data-to="opencode-1"]')?.classList.contains("active"), { timeout: 1000 });
    const activeStroke = await edge.evaluate((el) => getComputedStyle(el).stroke);
    if (!activeStroke) throw new Error("active edge had no visible stroke");
    if (await reverse.evaluate((el) => el.classList.contains("active"))) throw new Error("reverse edge flashed for one-way mail");
    await shot(page, "06-canvas-flash-active.png");

    await sleep(260);
    await page.evaluate(() => {
      const now = new Date().toISOString();
      (window as any).__meshStore.apply({
        t: "mail",
        name: "demo",
        entry: { id: `canvas-flash-renew-${Date.now()}`, ts: now, from: "codex-1", to: "opencode-1", body: "renew the glow" },
      });
    });
    await sleep(320);
    if (!(await edge.evaluate((el) => el.classList.contains("active")))) throw new Error("edge glow was not renewed by a second mail");
    await sleep(300);
    if (await edge.evaluate((el) => el.classList.contains("active"))) throw new Error("edge stayed active after trailing timeout");
    await canvas.locator(".canvas-close").click();
    await canvas.waitFor({ state: "detached", timeout: 4000 });
  });

  await step("mesh canvas layout persists and topology signature changes relayout", async () => {
    const key = "mesh-canvas-layout:demo";
    if (await page.locator(".mesh-canvas").isVisible().catch(() => false)) await page.locator(".mesh-canvas .canvas-close").click();
    await page.evaluate((k) => localStorage.removeItem(k), key);
    await page.locator('.drail .panel:has(.head:has-text("topology")) .btn:has-text("⤢")').click();
    const canvas = page.locator(".mesh-canvas");
    await canvas.waitFor({ timeout: 5000 });
    const router = canvas.locator('.canvas-window[data-agent="router"]');
    const before = await router.boundingBox();
    if (!before) throw new Error("router window missing");
    await router.locator(".canvas-window-head").dragTo(canvas, { targetPosition: { x: before.x + 140, y: before.y + 90 } });
    const moved = await router.boundingBox();
    if (!moved) throw new Error("router window missing after drag");
    await canvas.locator(".canvas-close").click();

    await page.locator('.drail .panel:has(.head:has-text("topology")) .btn:has-text("⤢")').click();
    await canvas.waitFor({ timeout: 5000 });
    const restored = await router.boundingBox();
    if (!restored || Math.abs(restored.x - moved.x) > 6 || Math.abs(restored.y - moved.y) > 6) {
      throw new Error(`layout did not restore (${restored?.x},${restored?.y}) vs (${moved.x},${moved.y})`);
    }
    const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), key);
    if (!saved?.sig || !saved?.windows?.router) throw new Error("canvas layout was not persisted");
    await canvas.locator(".canvas-close").click();

    await page.evaluate((k) => {
      const saved = JSON.parse(localStorage.getItem(k)!);
      saved.sig = "stale-signature";
      saved.windows.router.x = 19;
      saved.windows.router.y = 19;
      localStorage.setItem(k, JSON.stringify(saved));
    }, key);
    await page.locator('.drail .panel:has(.head:has-text("topology")) .btn:has-text("⤢")').click();
    await canvas.waitFor({ timeout: 5000 });
    const relayout = await router.boundingBox();
    if (!relayout || Math.abs(relayout.x - 19) < 30 || Math.abs(relayout.y - 19) < 30) throw new Error("stale signature layout was reused");
    await canvas.locator(".canvas-close").click();
  });

  await step("mesh canvas curves a blocked edge around an intervening window", async () => {
    const key = "mesh-canvas-layout:demo";
    if (await page.locator(".mesh-canvas").isVisible().catch(() => false)) {
      await page.locator(".mesh-canvas .canvas-close").click();
      await page.locator(".mesh-canvas").waitFor({ state: "detached", timeout: 4000 });
    }
    await page.evaluate((k) => localStorage.removeItem(k), key);
    await page.locator('.drail .panel:has(.head:has-text("topology")) .btn:has-text("⤢")').click();
    let canvas = page.locator(".mesh-canvas");
    await canvas.waitFor({ timeout: 5000 });
    await canvas.locator(".canvas-close").click();
    await canvas.waitFor({ state: "detached", timeout: 4000 });
    await page.evaluate((k) => {
      const saved = JSON.parse(localStorage.getItem(k)!);
      saved.windows["codex-1"] = { x: 110, y: 360, w: 300, h: 240 };
      saved.windows["opencode-1"] = { x: 1030, y: 360, w: 300, h: 240 };
      saved.windows.router = { x: 590, y: 330, w: 300, h: 300 };
      localStorage.setItem(k, JSON.stringify(saved));
    }, key);

    await page.locator('.drail .panel:has(.head:has-text("topology")) .btn:has-text("⤢")').click();
    canvas = page.locator(".mesh-canvas");
    await canvas.waitFor({ timeout: 5000 });
    const edge = canvas.locator('.canvas-edge[data-from="codex-1"][data-to="opencode-1"]');
    await edge.waitFor({ state: "attached", timeout: 4000 });
    const d = await edge.getAttribute("d");
    const route = await edge.getAttribute("data-route");
    if (!d?.includes(" C ")) throw new Error(`blocked edge did not render as a cubic path: ${d}`);
    if (route !== "avoid") throw new Error(`blocked edge route was ${route}`);
    const routerBox = await canvas.locator('.canvas-window[data-agent="router"]').boundingBox();
    if (!routerBox) throw new Error("router blocker missing");
    const intersects = await edge.evaluate((el, box) => {
      const path = el as SVGPathElement;
      const len = path.getTotalLength();
      for (let i = 1; i < 40; i++) {
        const p = path.getPointAtLength((len * i) / 40);
        if (p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height) return true;
      }
      return false;
    }, routerBox);
    if (intersects) throw new Error("routed edge still sampled inside the intervening router window");
    await shot(page, "07-canvas-avoid.png");
    await canvas.locator(".canvas-close").click();
    await canvas.waitFor({ state: "detached", timeout: 4000 });
  });

  await step("mesh canvas falls back to a straight path when blockers box in the route", async () => {
    const key = "mesh-canvas-layout:demo";
    if (await page.locator(".mesh-canvas").isVisible().catch(() => false)) {
      await page.locator(".mesh-canvas .canvas-close").click();
      await page.locator(".mesh-canvas").waitFor({ state: "detached", timeout: 4000 });
    }
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      const state = store.getState();
      const blockers = [
        { id: "block-top", harness: "codex", role: "member", status: "ready", activity: "idle" },
        { id: "block-bottom", harness: "codex", role: "member", status: "ready", activity: "idle" },
      ];
      store.apply({
        t: "mesh.list",
        meshes: state.meshes.map((m: any) =>
          m.name === "demo"
            ? { ...m, agents: [...m.agents.filter((a: any) => !String(a.id).startsWith("block-")), ...blockers] }
            : m,
        ),
      });
    });
    try {
      await page.evaluate((k) => localStorage.removeItem(k), key);
      await page.locator('.drail .panel:has(.head:has-text("topology")) .btn:has-text("⤢")').click();
      let canvas = page.locator(".mesh-canvas");
      await canvas.waitFor({ timeout: 5000 });
      await canvas.locator(".canvas-close").click();
      await canvas.waitFor({ state: "detached", timeout: 4000 });
      await page.evaluate((k) => {
        const saved = JSON.parse(localStorage.getItem(k)!);
        saved.windows["codex-1"] = { x: 80, y: 420, w: 280, h: 220 };
        saved.windows["opencode-1"] = { x: 1140, y: 420, w: 280, h: 220 };
        saved.windows.router = { x: 535, y: 390, w: 370, h: 260 };
        saved.windows["block-top"] = { x: 300, y: 40, w: 820, h: 360 };
        saved.windows["block-bottom"] = { x: 300, y: 610, w: 820, h: 280 };
        localStorage.setItem(k, JSON.stringify(saved));
      }, key);

      await page.locator('.drail .panel:has(.head:has-text("topology")) .btn:has-text("⤢")').click();
      canvas = page.locator(".mesh-canvas");
      await canvas.waitFor({ timeout: 5000 });
      const edge = canvas.locator('.canvas-edge[data-from="codex-1"][data-to="opencode-1"]');
      await edge.waitFor({ state: "attached", timeout: 4000 });
      const d = await edge.getAttribute("d");
      const route = await edge.getAttribute("data-route");
      if (route !== "fallback") throw new Error(`boxed-in route was ${route}`);
      if (!d?.includes(" L ") || d.includes(" C ")) throw new Error(`fallback edge was not a straight path: ${d}`);
      await canvas.locator(".canvas-close").click();
      await canvas.waitFor({ state: "detached", timeout: 4000 });
    } finally {
      await page.evaluate((k) => {
        const store = (window as any).__meshStore;
        const state = store.getState();
        store.apply({
          t: "mesh.list",
          meshes: state.meshes.map((m: any) =>
            m.name === "demo" ? { ...m, agents: m.agents.filter((a: any) => !String(a.id).startsWith("block-")) } : m,
          ),
        });
        localStorage.removeItem(k);
      }, key);
      if (await page.locator(".mesh-canvas").isVisible().catch(() => false)) {
        await page.locator(".mesh-canvas .canvas-close").click();
        await page.locator(".mesh-canvas").waitFor({ state: "detached", timeout: 4000 });
      }
    }
  });

  await step("mobile detail has a single chat segment without separate agents segment", async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForSelector(".mdetail .conv-panel", { timeout: 4000 });
    const tabs = await page.locator(".mtabs .mtab").allTextContents();
    if (tabs.some((x) => /agents/i.test(x))) throw new Error(`mobile still has agents segment: ${tabs.join(",")}`);
    if (!tabs.some((x) => /chat/i.test(x))) throw new Error(`mobile missing chat segment: ${tabs.join(",")}`);
    await page.locator(".mdetail .conv-router-tab .dot").waitFor({ timeout: 4000 });

    const panel = page.locator(".mdetail .conv-panel");
    if (await panel.locator(".conv-head").isVisible()) throw new Error("mobile conversation header should be hidden");

    await page.evaluate(() => (window as any).__meshStore.apply({ t: "agent.activity", name: "demo", agent: "codex-1", activity: "working" }));
    await panel.locator('.conv-member-tab:has-text("codex-1")').click();
    await panel.locator(".conv-control .effort-sel[aria-label]").waitFor({ timeout: 4000 });
    await panel.locator(".conv-control .mode-sel[aria-label]").waitFor({ timeout: 4000 });
    await panel.locator(".conv-control .model-sel[aria-label]").waitFor({ timeout: 4000 });
    const controlText = (await panel.locator(".conv-control").innerText()).toLowerCase();
    if (controlText.includes("thinking") || controlText.includes("effort") || controlText.includes("mode") || controlText.includes("model")) {
      throw new Error(`mobile control labels still visible: ${controlText}`);
    }
    const interrupt = panel.locator(".composer .compose-interrupt");
    await interrupt.waitFor({ timeout: 4000 });
    const interruptLabel = await interrupt.getAttribute("aria-label");
    const interruptTitle = await interrupt.getAttribute("title");
    if (!interruptLabel || !interruptTitle) throw new Error("mobile interrupt button is missing aria-label/title");
    const interruptVisual = await interrupt.evaluate((el) => {
      const text = el.querySelector(".compose-interrupt-text") as HTMLElement | null;
      const icon = el.querySelector(".compose-interrupt-icon") as HTMLElement | null;
      const textBox = text?.getBoundingClientRect();
      const iconStyle = icon ? getComputedStyle(icon) : null;
      return {
        textWidth: textBox?.width ?? 0,
        textHeight: textBox?.height ?? 0,
        iconDisplay: iconStyle?.display ?? "",
        iconText: icon?.textContent?.trim() ?? "",
      };
    });
    if (interruptVisual.textWidth > 2 || interruptVisual.textHeight > 2 || interruptVisual.iconDisplay === "none" || interruptVisual.iconText !== "⏹") {
      throw new Error(`mobile interrupt should be visually icon-only: ${JSON.stringify(interruptVisual)}`);
    }
    const interruptBox = await interrupt.boundingBox();
    if (!interruptBox || interruptBox.width < 44 || interruptBox.height < 44) {
      throw new Error(`mobile interrupt touch target too small: ${interruptBox?.width}x${interruptBox?.height}`);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector(".drail", { timeout: 4000 });
  });

  await step("mesh builder: invalid config shows inline error", async () => {
    await page.locator('.panel:has(.head:has-text("meshes")) .btn:has-text("new")').click();
    await page.waitForSelector(".modal", { timeout: 4000 });
    // name empty + only one router but blank name → error
    await page.locator('.modal .btn:has-text("define mesh")').click();
    await page.waitForSelector(".modal .err", { timeout: 4000 });
  });

  await step("mesh builder: valid config creates a mesh", async () => {
    await page.locator('.modal .field:has(label:has-text("mesh name")) input').fill("squad-x");
    await page.locator('.modal .builder-tab:has-text("router")').click();
    const harnessSelect = page.locator(".modal .agent-block .agrow-runtime select").first();
    await harnessSelect.locator('option[value="kimi"]:has-text("not installed")').waitFor({ state: "attached", timeout: 4000 });
    if (!(await harnessSelect.locator('option[value="kimi"]').isDisabled())) throw new Error("uninstalled harness option was not disabled");
    const harnessOpts = await harnessSelect.locator("option").allTextContents();
    if (!harnessOpts.some((opt) => opt.includes("kimi"))) throw new Error(`builder harness options missing kimi: ${harnessOpts.join(",")}`);
    await page.locator(".modal .agent-instructions").first().fill("Router should coordinate handoffs and keep tasks scoped.");
    await page.locator('.modal .btn:has-text("+ agent")').click();
    await page.waitForSelector('.modal .builder-tab[aria-selected="true"]:has-text("agent-1")', { timeout: 4000 });
    await page.locator(".modal .agrow-identity").locator("input").first().fill("worker");
    await page.locator(".modal .agrow-runtime").locator("select").first().selectOption("opencode");
    await page.locator(".modal .agrow-identity").locator("select").first().selectOption("member");
    await page.locator('.modal .builder-tab:has-text("overview")').click();
    await page.locator('.modal .btn:has-text("+ edge")').click();
    await page.locator('.modal .field:has(label:has-text("mail edges")) .row').last().locator("select").nth(0).selectOption("router");
    await page.locator('.modal .field:has(label:has-text("mail edges")) .row').last().locator("select").nth(1).selectOption("worker");
    await page.locator('.modal .field:has(label:has-text("mail edges")) .row').last().locator('input[type="checkbox"]').check();
    await page
      .locator('.modal .field:has(label:has-text("team charter")) textarea')
      .fill("Goal: build a tiny CLI. Norms: be concise, write a test.");
    // set the (claude) agent's startup model and thinking effort.
    await page.locator('.modal .builder-tab:has-text("router")').click();
    const adv = page.locator(".modal .agrow-adv .adv-sel");
    if ((await adv.count()) !== 2) throw new Error("builder should render model and effort selectors on the active agent page");
    await adv.nth(0).locator('option[value="claude-sonnet-4.5"]').waitFor({ state: "attached", timeout: 4000 });
    await adv.nth(0).selectOption("claude-sonnet-4.5"); // model
    await adv.nth(1).selectOption("high"); // effort
    await page.locator('.modal .builder-tab:has-text("worker")').click();
    await page.locator(".modal .agent-block").locator('label:has-text("lazy start") input').check();
    await page.locator('.modal .builder-tab:has-text("overview")').click();
    await page.locator('.modal .btn:has-text("define mesh")').click();
    await page.waitForSelector('.mrow:has-text("squad-x")', { timeout: 6000 });
    // and it auto-opens its console (regression: post-snapshot mesh had no perMesh)
    await page.waitForSelector('.detail-head:has-text("squad-x")', { timeout: 4000 });
    await page.waitForSelector('.panel:has(.head:has-text("topology")) .node', { timeout: 4000 });
  });

  await step("edit a mesh prefills the builder with its config (name locked)", async () => {
    await page.locator('.detail-head .btn:has-text("edit")').click();
    await page.waitForSelector('.modal .mhead:has-text("edit mesh")', { timeout: 4000 });
    const tabs = await page.locator(".modal .builder-tab").allTextContents();
    for (const label of ["overview", "router", "worker"]) {
      if (!tabs.some((tab) => tab.includes(label))) throw new Error(`builder tab missing ${label}: ${tabs.join(",")}`);
    }
    const val = await page.locator('.modal .field:has(label:has-text("mesh name")) input').inputValue();
    if (val !== "squad-x") throw new Error(`edit prefill wrong name: "${val}"`);
    const charterVal = await page.locator('.modal .field:has(label:has-text("team charter")) textarea').inputValue();
    if (!charterVal.includes("build a tiny CLI")) throw new Error(`charter not prefilled: "${charterVal}"`);
    await page.locator('.modal .builder-tab:has-text("router")').click();
    const instructionsVal = await page.locator(".modal .agent-instructions").first().inputValue();
    if (!instructionsVal.includes("coordinate handoffs")) throw new Error(`instructions not prefilled: "${instructionsVal}"`);
    const longInstructions = "Router should coordinate handoffs and keep tasks scoped.\n\n" + "Escalate ambiguity with a concise note.\n".repeat(18);
    const firstExpand = page.locator(".modal .agent-block").first().locator('.btn:has-text("expand")');
    await firstExpand.click();
    await page.waitForSelector('.text-editor-dialog:has-text("role-specific instructions") textarea', { timeout: 4000 });
    const focused = await page.locator(".text-editor-dialog textarea").evaluate((el) => el === document.activeElement);
    if (!focused) throw new Error("expanded instructions editor did not focus its textarea");
    await page.keyboard.press("Shift+Tab");
    const stillInDialogAfterShiftTab = await page.locator(".text-editor-dialog").evaluate((dialog) => dialog.contains(document.activeElement));
    if (!stillInDialogAfterShiftTab) throw new Error("Shift+Tab escaped the expanded text editor dialog");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const stillInDialogAfterTab = await page.locator(".text-editor-dialog").evaluate((dialog) => dialog.contains(document.activeElement));
    if (!stillInDialogAfterTab) throw new Error("Tab escaped the expanded text editor dialog");
    await page.locator(".text-editor-dialog textarea").fill("discard me");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".text-editor-dialog", { state: "detached", timeout: 4000 });
    await page.waitForSelector('.modal .mhead:has-text("edit mesh")', { timeout: 4000 });
    const focusReturned = await firstExpand.evaluate((el) => el === document.activeElement);
    if (!focusReturned) throw new Error("expanded instructions editor did not restore focus to its trigger");
    if ((await page.locator(".modal .agent-instructions").first().inputValue()) !== instructionsVal) {
      throw new Error("Escape from expanded instructions editor should cancel without changing the field");
    }
    await firstExpand.click();
    await page.waitForSelector('.text-editor-dialog:has-text("role-specific instructions") textarea', { timeout: 4000 });
    await page.locator(".text-editor-dialog textarea").fill(longInstructions);
    await page.locator('.text-editor-dialog .btn:has-text("apply")').click();
    await page.waitForSelector(".text-editor-dialog", { state: "detached", timeout: 4000 });
    if ((await page.locator(".modal .agent-instructions").first().inputValue()) !== longInstructions) {
      throw new Error("expanded instructions editor did not save back to the agent field");
    }
    const longCharter = "Goal: build a tiny CLI.\n\n" + "Norm: keep handoffs explicit and include verification evidence.\n".repeat(16);
    await page.locator('.modal .builder-tab:has-text("overview")').click();
    await page.locator('.modal .field:has(label:has-text("team charter")) .btn:has-text("expand")').click();
    await page.waitForSelector('.text-editor-dialog:has-text("team charter") textarea', { timeout: 4000 });
    await page.locator(".text-editor-dialog textarea").fill(longCharter);
    await page.locator('.text-editor-dialog .btn:has-text("apply")').click();
    await page.waitForSelector(".text-editor-dialog", { state: "detached", timeout: 4000 });
    if ((await page.locator('.modal .field:has(label:has-text("team charter")) textarea').inputValue()) !== longCharter) {
      throw new Error("expanded charter editor did not save back to the charter field");
    }
    // model and effort round-trip from the saved config.
    await page.locator('.modal .builder-tab:has-text("router")').click();
    const adv2 = page.locator(".modal .agrow-adv .adv-sel");
    if ((await adv2.count()) !== 2) throw new Error("edit builder should render model and effort selectors on the active agent page");
    await adv2.nth(0).locator('option[value="claude-sonnet-4.5"]').waitFor({ state: "attached", timeout: 4000 });
    if ((await adv2.nth(0).inputValue()) !== "claude-sonnet-4.5") throw new Error("model not prefilled");
    if ((await adv2.nth(1).inputValue()) !== "high") throw new Error("effort not prefilled");
    await page.locator('.modal .builder-tab:has-text("worker")').click();
    if (!(await page.locator(".modal .agent-block").locator('label:has-text("lazy start") input').isChecked())) {
      throw new Error("lazy checkbox not prefilled");
    }
    await page.locator('.modal .btn:has-text("+ agent")').click();
    await page.waitForSelector('.modal .builder-tab[aria-selected="true"]:has-text("agent-2")', { timeout: 4000 });
    await page.locator('.modal .builder-tab[aria-selected="true"] .builder-tab-remove').click();
    await page.waitForSelector('.modal .builder-tab:has-text("agent-2")', { state: "detached", timeout: 4000 });
    await page.locator('.modal .builder-tab:has-text("overview")').click();
    const steerChecked = await page.locator('.modal .field:has(label:has-text("mail edges")) input[type="checkbox"]').first().isChecked();
    if (!steerChecked) throw new Error("steer checkbox not prefilled");
    await page.locator('.modal .btn:has-text("save mesh")').click();
    await page.waitForSelector(".modal", { state: "detached", timeout: 4000 });
    await page.waitForSelector('.mrow:has-text("squad-x")', { timeout: 4000 });
  });

  await step("lazy member starts cold and can be manually woken", async () => {
    await page.locator('.detail-head .btn:has-text("start mesh")').click();
    await page.waitForSelector('.detail-head:has-text("squad-x") .meta:has-text("running")', { timeout: 6000 });
    await page.locator('.conv-member-tab:has-text("worker")').click();
    await page.waitForSelector('.conv-control .btn:has-text("start")', { timeout: 5000 });
    const workerTab = page.locator('.conv-member-tab:has-text("worker") .dot').first();
    if (!(await workerTab.evaluate((el) => el.classList.contains("cold")))) throw new Error("worker tab did not show cold status");
    await page.locator('.conv-control .btn:has-text("start")').click();
    await page.locator('.conv-member-tab:has-text("worker") .dot.ready').waitFor({ timeout: 5000 });
    await page.locator('.detail-head .btn:has-text("stop mesh")').click();
    await page.locator('.detail-head .btn:has-text("stop?")').click();
    await page.waitForSelector('.detail-head .btn:has-text("start mesh")', { timeout: 5000 });
  });

  await step("mesh builder rejects steer edges targeting the router", async () => {
    await page.locator('.detail-head .btn:has-text("edit")').click();
    await page.waitForSelector('.modal .mhead:has-text("edit mesh")', { timeout: 4000 });
    const edgeRow = page.locator('.modal .field:has(label:has-text("mail edges")) .row').first();
    await edgeRow.locator("select").nth(0).selectOption("worker");
    await edgeRow.locator("select").nth(1).selectOption("router");
    await edgeRow.locator('input[type="checkbox"]').check();
    await page.locator('.modal .btn:has-text("save mesh")').click();
    await page.waitForSelector(".modal .err", { timeout: 4000 });
    await page.locator(".modal .mhead .btn").click();
    await page.waitForSelector(".modal", { state: "detached", timeout: 4000 });
  });

  await step("mesh builder edit modal fits a 380px mobile viewport", async () => {
    await page.locator('.detail-head .btn:has-text("edit")').click();
    await page.waitForSelector('.modal .mhead:has-text("edit mesh")', { timeout: 4000 });
    await page.setViewportSize({ width: 380, height: 820 });

    const routerTab = page.locator('.modal .builder-tab:has-text("router")').first();
    await routerTab.waitFor({ state: "visible", timeout: 4000 });
    const tabOk = await routerTab.evaluate((el) => {
      const text = el.textContent ?? "";
      return text.includes("router") && el.scrollWidth <= el.clientWidth + 1;
    });
    if (!tabOk) throw new Error("router tab text is clipped at 380px");

    await routerTab.click();
    const contained = await page.locator(".modal").evaluate((modal) => {
      const modalRight = modal.getBoundingClientRect().right;
      const fields = Array.from(modal.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select"))
        .filter((el) => el.offsetParent !== null);
      return fields.every((el) => el.getBoundingClientRect().right <= modalRight + 1);
    });
    if (!contained) throw new Error("builder controls overflow the modal at 380px");

    const saveVisible = await page.locator('.modal .builder-actions .btn:has-text("save mesh")').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.bottom <= window.innerHeight && rect.top >= 0;
    });
    if (!saveVisible) throw new Error("sticky save button is not visible without scrolling at 380px");
    await shot(page, "mesh-builder-mobile-380.png");

    await page.setViewportSize({ width: 1280, height: 800 });
    const desktopRowsFill = await page.locator(".modal .agent-block").evaluate((block) => {
      const rows = Array.from(block.querySelectorAll<HTMLElement>(".agrow-identity, .agrow-runtime"));
      return rows.every((row) => {
        const last = row.lastElementChild;
        if (!(last instanceof HTMLElement)) return false;
        const rowRight = row.getBoundingClientRect().right;
        const lastRight = last.getBoundingClientRect().right;
        return Math.abs(rowRight - lastRight) <= 24;
      });
    });
    if (!desktopRowsFill) throw new Error("desktop identity/runtime rows do not fill the available row width");
    await shot(page, "mesh-builder-desktop-1280.png");
    await page.locator(".modal .mhead .btn").click();
    await page.waitForSelector(".modal", { state: "detached", timeout: 4000 });
  });

  await step("delete a stopped mesh (two-click confirm) removes it", async () => {
    // squad-x is selected + stopped → its header shows a delete button
    await page.locator('.detail-head .btn:has-text("delete")').click();
    await page.locator('.detail-head .btn:has-text("delete?")').click();
    await page.waitForSelector('.mrow:has-text("squad-x")', { state: "detached", timeout: 5000 });
  });

  await shot(page, "04-final.png");

  await step("no console/page errors", async () => {
    if (errors.length) throw new Error(`${errors.length} console errors: ${errors.slice(0, 3).join(" || ")}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  BROWSER E2E OK — screenshots in /tmp/mesh-shots");
  }
} finally {
  await browser.close();
  server.kill();
}
