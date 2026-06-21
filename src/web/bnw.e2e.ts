// Step 7.0 — `/bnw/` console smoke e2e: boots the web server over a FAKE gateway (no real
// agents), seeds an approved device token, and drives a real browser to verify the new
// parallel shell mounts under /bnw/, route-switches across surfaces, renders placeholders,
// and does same-origin SPA navigation via RouteLink. Run: bun run src/web/bnw.e2e.ts
import { WebGateway } from "./gateway";
import { startWebServer } from "./server";
import { authedContext, launchChromium, provisionE2eAuth } from "./e2e-playwright";
import { rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import type { MeshEvent, MeshConfig } from "../acp/types";

const SHOTS = process.env.AGENT_MESH_ARTIFACTS || "/tmp/mesh-shots";
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MESHES = ["demo", "alpha"];
const cfgOf = (name: string): MeshConfig => ({
  name,
  agents: [{ id: "router", harness: "claude", project: "p", role: "router" }],
  edges: [],
});

// Records every mutation the gateway forwards, so the browser smoke can prove a clicked
// control reaches the real store→API→gateway→manager path (not just renders).
const calls: string[] = [];
const rec = (s: string) => { calls.push(s); };
const okMut = { saved: true, applied: true } as const;
// Capture the gateway's event listener so the e2e can emit real MeshEvents (e.g. a queued
// turn) — the gateway folds them into its own state + broadcasts, which is what some
// server-side guards (removeQueuedTurn) validate against.
let mgrListener: ((n: string, e: MeshEvent) => void) | null = null;
const emit = (name: string, event: MeshEvent) => mgrListener?.(name, event);

function fakeManager() {
  return {
    on(l: (n: string, e: MeshEvent) => void) { mgrListener = l; return () => { mgrListener = null; }; },
    listMeshes() { return MESHES.map((name) => ({ name, defined: true, status: "stopped" as const })); },
    configOf(name: string) { return cfgOf(name); },
    routerOf() { return "router"; },
    async startMesh(name: string, opts?: { sessionStrategy?: string }) { rec(`startMesh:${name}:${opts?.sessionStrategy ?? "resume"}`); },
    async stopMesh(name: string) { rec(`stopMesh:${name}`); },
    async promptRouter() {},
    promptAgent(name: string, agentId: string, text: string) { rec(`promptAgent:${name}:${agentId}:${text}`); },
    steerAgent(name: string, agentId: string, text: string) { rec(`steerAgent:${name}:${agentId}:${text}`); },
    removeQueuedTurn(name: string, agentId: string, turnId: string) { rec(`removeQueuedTurn:${name}:${agentId}:${turnId}`); },
    resolvePermission(name: string, requestId: string, optionId: string) { rec(`resolvePermission:${name}:${requestId}:${optionId}`); },
    async setMode(name: string, agentId: string, modeId: string) { rec(`setMode:${name}:${agentId}:${modeId}`); return okMut; },
    async setModel(name: string, agentId: string, modelId: string) { rec(`setModel:${name}:${agentId}:${modelId}`); return okMut; },
    async setAgentEffort(name: string, agentId: string, effort?: string) { rec(`setEffort:${name}:${agentId}:${effort}`); return okMut; },
    wakeAgent(name: string, agentId: string) { rec(`wakeAgent:${name}:${agentId}`); },
    interruptAgent(name: string, agentId: string) { rec(`interruptAgent:${name}:${agentId}`); },
    async newAgentSession(name: string, agentId: string) { rec(`newAgentSession:${name}:${agentId}`); },
    async newAllSessions(name: string) { rec(`newAllSessions:${name}`); },
    stopAgent(name: string, agentId: string) { rec(`stopAgent:${name}:${agentId}`); },
    async addEdge(name: string, edge: { from: string; to: string }) { rec(`addEdge:${name}:${edge.from}->${edge.to}`); },
    async addAgent(name: string, agent: { id: string }) { rec(`addAgent:${name}:${agent.id}`); },
    async defineMesh() {}, async deleteMesh() {}, async loadDefinitions() {}, async stopAll() {},
  };
}

function assert(cond: unknown, msg: string) { if (!cond) throw new Error(`BNW E2E FAIL: ${msg}`); }
// Poll the in-process call log until the gateway forwards the expected mutation (or time out).
async function waitCall(sub: string, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (calls.some((c) => c.includes(sub))) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`BNW E2E FAIL: expected manager call containing "${sub}"; got: [${calls.join(" | ")}]`);
}
// A rich client-side snapshot so the focus controls render enabled (running mesh, ready
// agent, model options, a pending approval, a queued turn). Applied via __meshStore.apply.
const SEED_FOCUS = {
  meshes: [{ name: "demo", defined: true, status: "running", router: "router",
    agents: [{ id: "router", harness: "claude", role: "router", status: "ready", activity: "idle" }], edges: [] }],
  assistant: { status: "absent", transcript: [] },
  perMesh: { demo: {
    config: { name: "demo", agents: [], edges: [] },
    transcripts: { router: { items: [], hasMore: false } },
    activity: [], mail: [], history: [],
    pending: [{ requestId: "rq1", agent: "router", question: "write config.json?", options: [{ id: "allow", name: "Allow" }, { id: "deny", name: "Deny" }], ts: "1" }],
    modes: {}, models: { router: { current: "opus-4.8", available: [{ id: "opus-4.8", name: "Opus 4.8" }, { id: "sonnet-4.6", name: "Sonnet 4.6" }] } }, efforts: {},
    capabilities: {}, usage: {}, health: {}, selfAwareness: {},
    queues: { router: { count: 1, items: [{ id: "q1", source: "operator", preview: "queued prompt", ts: "1" }] } },
    board: null,
  } },
};

// A running mesh with edges + recent mail, so the canvas renders directed/highlighted edges
// and the per-node + add-agent/edge controls are enabled.
const SEED_CANVAS = {
  meshes: [{ name: "demo", defined: true, status: "running", router: "router",
    agents: [
      { id: "router", harness: "claude", role: "router", status: "ready", activity: "idle" },
      { id: "codex-1", harness: "codex", role: "member", status: "ready", activity: "working" },
    ], edges: [{ from: "router", to: "codex-1" }] }],
  assistant: { status: "absent", transcript: [] },
  perMesh: { demo: { ...SEED_FOCUS.perMesh.demo, mail: [{ id: "m1", ts: "1", from: "router", to: "codex-1", body: "go" }] } },
};

const auth = await provisionE2eAuth();
const gw = new WebGateway(fakeManager() as any, undefined, { root: auth.authRoot });
const handle = startWebServer({ gateway: gw, port: 0, dev: false }); // no HMR (prod-like serving)
const BASE = handle.url;
const browser = await launchChromium();
const errors: string[] = [];
let passed = 0;
const step = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

try {
  const ctx = await authedContext(browser, auth.token, { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|_bun\/hmr/.test(m.text())) errors.push(m.text()); });

  await step("/bnw/ mounts the new shell + lands on default mesh runtime", async () => {
    await page.goto(`${BASE}/bnw/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw="shell"]', { timeout: 10000 });
    // home → default mesh runtime (replace nav once meshes arrive over WS)
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 10000 });
    assert(/\/bnw\/mesh\/(demo|alpha)$/.test(new URL(page.url()).pathname), `landed on a mesh runtime (got ${page.url()})`);
    if (await page.locator('nav[aria-label="meshes"] a').count() < 2) throw new Error("mesh nav rows missing");
  });

  await step("deep-link board / doctor / settings / notFound switch the surface", async () => {
    for (const [path, surface] of [
      ["/bnw/mesh/demo/board", "board"],
      ["/bnw/mesh/demo/canvas", "runtime"],
      ["/bnw/doctor", "doctor"],
      ["/bnw/settings", "settings"],
      ["/bnw/harnesses", "harnesses"],
      ["/bnw/notifications", "notifications"],
      ["/bnw/mesh/new", "newMesh"],
      ["/bnw/nope/deep", "notFound"],
    ] as [string, string][]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`[data-bnw-surface="${surface}"]`, { timeout: 8000 });
    }
  });

  await step("7.1-A runtime overview + focus wired to the real store", async () => {
    // overview reads the snapshot: agents grid + the store-fed agent id "router"
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await page.waitForSelector('[data-bnw-agents]', { timeout: 8000 });
    if (await page.locator('[data-bnw-agents]').getByText("router", { exact: false }).count() === 0) throw new Error("store-fed agent missing in /bnw overview");
    // focus reads the per-agent store + the transcript region renders
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-focus="split"]', { timeout: 8000 });
    await page.waitForSelector('[data-bnw-transcript]', { timeout: 8000 });
    // ?full=1 is URL-driven and switches the focus frame
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router?full=1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-focus="full"]', { timeout: 8000 });
    if (await page.locator('[data-bnw-focus="split"]').count() !== 0) throw new Error("full=1 must not render the split frame");
  });

  await step("7.1-B mutations reach the gateway: lifecycle Start (overview)", async () => {
    // real gateway snapshot = stopped → Start + strategy select; choose fresh, click Start.
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-lifecycle]', { timeout: 8000 });
    await page.locator('[aria-label="start strategy"]').selectOption("fresh");
    await page.getByRole("button", { name: "Start" }).click();
    await waitCall("startMesh:demo:fresh");
  });

  await step("7.1-B mutations reach the gateway: focus selectors / composer / approval / queue", async () => {
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-focus="split"]', { timeout: 8000 });
    const seed = () => page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_FOCUS);

    // #10 selector → setModel
    await seed();
    await page.waitForSelector('[aria-label="router model"]', { timeout: 8000 });
    await page.locator('[aria-label="router model"]').selectOption("sonnet-4.6");
    await waitCall("setModel:demo:router:sonnet-4.6");

    // composer → promptAgent (router idle → prompt, not steer)
    await seed();
    await page.locator('[aria-label="message input"]').fill("hello from bnw e2e");
    await page.getByRole("button", { name: "Send" }).click();
    await waitCall("promptAgent:demo:router:hello from bnw e2e");

    // C2 approval first option → resolvePermission (FIFO bar visible first)
    await seed();
    await page.waitForSelector('[data-bnw-approval]', { timeout: 8000 });
    await page.locator('[aria-label="resolve allow"]').click();
    await waitCall("resolvePermission:demo:rq1:allow");

    // queue remove → removeQueuedTurn. The gateway validates against ITS OWN queue, so emit
    // a real queued-turn MeshEvent: the gateway folds it + broadcasts agent.queue to the client.
    await seed();
    emit("demo", { kind: "agent_turn", phase: "queued", ts: "1",
      turn: { id: "q1", agent: "router", source: "operator", from: "operator", text: "queued prompt", preview: "queued prompt", ts: "1" } } as MeshEvent);
    await page.waitForSelector('[aria-label="remove queued q1"]', { timeout: 8000 });
    await page.locator('[aria-label="remove queued q1"]').click();
    await waitCall("removeQueuedTurn:demo:router:q1");
  });

  await step("7.1-B mutations reach the gateway: wake cold agent (overview)", async () => {
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-agents]', { timeout: 8000 });
    // seed a cold agent so the overview renders a real Wake button
    await page.evaluate(() => (window as any).__meshStore.apply({ t: "snapshot", state: {
      meshes: [{ name: "demo", defined: true, status: "running", router: "router",
        agents: [{ id: "kimi-1", harness: "kimi", role: "member", status: "cold", activity: "idle" }], edges: [] }],
      assistant: { status: "absent", transcript: [] }, perMesh: {},
    } }));
    await page.waitForSelector('[aria-label="wake kimi-1"]', { timeout: 8000 });
    await page.locator('[aria-label="wake kimi-1"]').click();
    await waitCall("wakeAgent:demo:kimi-1");
  });

  await step("RouteLink does same-origin SPA nav (no full reload) runtime→board", async () => {
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await page.evaluate(() => ((window as any).__bnwNav = true)); // marker cleared by a real reload
    await page.getByRole("link", { name: "看板" }).first().click();
    await page.waitForSelector('[data-bnw-surface="board"]', { timeout: 8000 });
    assert(await page.evaluate(() => (window as any).__bnwNav === true), "SPA nav must not full-reload the page");
    assert(new URL(page.url()).pathname === "/bnw/mesh/demo/board", `URL updated (got ${page.url()})`);
  });

  await step("file-viewer deep link with a dotted path resolves (not 404)", async () => {
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router/artifact/topology.png`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="file"]', { timeout: 8000 });
  });

  await step("7.1-C canvas: real edges + recent highlight + toolbar; add-edge/add-agent reach gateway", async () => {
    await page.goto(`${BASE}/bnw/mesh/demo/canvas`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-canvas]', { timeout: 8000 });
    const seed = () => page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_CANVAS);
    await seed();
    await page.waitForSelector('[data-edge-recent="true"]', { state: "attached", timeout: 8000 }); // directed + recent-mail edge
    for (const sel of ['[data-bnw-edges]', '[data-bnw-autolayout]', '[data-bnw-relayout]', '[aria-label="zoom in"]', '[aria-label="close canvas"]', '[data-bnw-topology]']) {
      if (await page.locator(sel).count() === 0) throw new Error(`canvas element missing: ${sel}`);
    }
    // #17 add edge → real addEdge
    await seed();
    await page.locator('[aria-label="add edge"]').click();
    await page.waitForSelector('[data-bnw-add-edge]', { timeout: 8000 });
    await page.locator('[aria-label="new edge from"]').selectOption("codex-1");
    await page.locator('[aria-label="new edge to"]').selectOption("router");
    await page.locator('[aria-label="confirm add edge"]').click();
    await waitCall("addEdge:demo:codex-1->router");
    // #17 add agent → real addAgent
    await seed();
    await page.locator('[aria-label="add agent"]').click();
    await page.waitForSelector('[data-bnw-add-agent]', { timeout: 8000 });
    await page.locator('[aria-label="new agent id"]').fill("reviewer-1");
    await page.locator('[aria-label="new agent project"]').fill("~/projects/app");
    await page.locator('[aria-label="confirm add agent"]').click();
    await waitCall("addAgent:demo:reviewer-1");
  });

  // ── user-review screenshots (<=1500 wide, in artifacts) ──
  await step("screenshots: overview / focus (C2 docked approval) / canvas / mobile overview", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // desktop overview
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-runtime-overview-desktop.png`, fullPage: true });
    // focus with the C2 docked approval bar (seed pending + ready agent)
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-focus="split"]', { timeout: 8000 });
    await page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_FOCUS);
    await page.waitForSelector('[data-bnw-approval]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-runtime-focus-desktop.png`, fullPage: true });
    // canvas with real edges + highlight
    await page.goto(`${BASE}/bnw/mesh/demo/canvas`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-canvas]', { timeout: 8000 });
    await page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_CANVAS);
    await page.waitForSelector('[data-edge-recent="true"]', { state: "attached", timeout: 8000 });
    await sleep(150); await page.screenshot({ path: `${SHOTS}/bnw-runtime-canvas-desktop.png`, fullPage: true });
    // mobile overview
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-runtime-overview-mobile.png`, fullPage: true });
  });

  if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log(`BNW E2E: ${passed} passed, 0 failed`);
  console.log("BNW E2E OK");
} finally {
  await browser.close();
  handle.stop();
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
