// Step 7.0 — `/bnw/` console smoke e2e: boots the web server over a FAKE gateway (no real
// agents), seeds an approved device token, and drives a real browser to verify the new
// parallel shell mounts under /bnw/, route-switches across surfaces, renders placeholders,
// and does same-origin SPA navigation via RouteLink. Run: bun run src/web/bnw.e2e.ts
import { WebGateway } from "./gateway";
import { startWebServer } from "./server";
import { authedContext, launchChromium, provisionE2eAuth } from "./e2e-playwright";
import { rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeRecord } from "../mesh-registry";
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

// Board document the fake serves via readBoard (the REAL ensureBoardLoaded fetch path), so
// /bnw board list/kanban/detail render real rows without client seeding.
const mkTask = (id: number, o: Record<string, unknown> = {}) => ({ id, title: `task ${id}`, status: "todo", priority: "normal", deps: [], subtasks: [], subtaskSeq: 0, revision: 1, createdBy: "router", createdAt: "", updatedAt: "", comments: [], mailEventIds: [], ...o });
const BOARD_DOC = {
  mesh: "demo", revision: 4, epicSeq: 1, taskSeq: 12, labelSeq: 2,
  epics: [{ id: "epic-1", seq: 1, title: "Onboarding", status: "in_progress", revision: 1, createdBy: "router", createdAt: "", updatedAt: "", comments: [] }],
  labels: [{ id: "label-1", name: "ui", color: "#bae6fd" }, { id: "label-2", name: "auth", color: "#e9d5ff" }],
  tasks: [
    mkTask(12, { epicId: "epic-1", title: "Add device-auth page", status: "in_review", assignee: "codex-1", priority: "high", labelIds: ["label-1", "label-2"], subtasks: [{ id: "12.1", title: "gate", status: "done", revision: 1, createdBy: "x", createdAt: "", updatedAt: "", comments: [] }], lifecycleEvents: [{ kind: "dispatched", by: "router", at: "" }], comments: [{ author: "router", text: "dispatched", ts: "" }] }),
    mkTask(9, { epicId: "epic-1", title: "Token contrast audit", status: "todo", assignee: "claude-1", deps: [12], labelIds: ["label-1"] }),
    mkTask(5, { title: "Drop legacy theme", status: "done", priority: "low" }),
  ],
};

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
    // board: real read path (ensureBoardLoaded → getBoard → readBoard) + command recorder.
    // Record the CAS tokens so the e2e can prove board-level (expectedBoardRevision) AND
    // per-entity (command.expectedRevision) revisions are wired correctly.
    async readBoard() { return BOARD_DOC; },
    async boardCommand(_name: string, _actor: unknown, command: { type: string; expectedRevision?: number }, expectedBoardRevision: number) {
      rec(`boardCommand:${command.type}:board=${expectedBoardRevision}:rev=${command.expectedRevision ?? "-"}`);
      return { ok: true, state: BOARD_DOC, change: {} };
    },
    async defineMesh(config: { name: string }) { rec(`defineMesh:${config.name}`); },
    async deleteMesh() {}, async reloadDefinitionsPreservingRuntime() { rec("reload"); }, async stopAll() {},
  };
}
// Assistant stub (WebGateway AssistantLike) so promptAssistant/interrupt reach a recorder.
const asstStub = { on() { return () => {}; }, async prompt(text: string) { rec(`assistantPrompt:${text}`); }, cancel() { rec("assistantCancel"); } };

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

// 7.5-D parity seeds. Overview: running mesh w/ a cold (lazy) agent (#11 wake), usage (#12),
// health near-limit (#12), silent-complete (#12), running → new-all-sessions (#18).
const SEED_PARITY_OVERVIEW = {
  meshes: [{ name: "demo", defined: true, status: "running", router: "router",
    agents: [
      { id: "router", harness: "claude", role: "router", status: "ready", activity: "idle" },
      { id: "lazy-1", harness: "codex", role: "member", status: "cold", activity: "idle" },
    ], edges: [] }],
  assistant: { status: "absent", transcript: [] },
  perMesh: { demo: {
    config: { name: "demo", agents: [], edges: [] },
    transcripts: {}, activity: [], mail: [], history: [], pending: [],
    modes: {}, models: {}, efforts: {}, capabilities: {},
    usage: { router: { used: 120000, size: 200000, cost: 0.42 } },
    health: { router: { signal: "near_limit" } },
    selfAwareness: { router: { silentTaskCompletes: { count: 2 } } },
    queues: {}, board: null,
  } },
};
// Focus: long transcript (jump-to-bottom #15) incl. thought/tool/mail expand kinds (#14),
// mode/model/effort selectors (#10), a queue (#13), a pending approval (C2 docked bar).
const SEED_PARITY_FOCUS = {
  meshes: [{ name: "demo", defined: true, status: "running", router: "router",
    agents: [{ id: "router", harness: "claude", role: "router", status: "ready", activity: "idle" }], edges: [] }],
  assistant: { status: "absent", transcript: [] },
  perMesh: { demo: {
    config: { name: "demo", agents: [], edges: [] },
    transcripts: { router: { items: [
      ...Array.from({ length: 80 }, (_, i) => ({ id: `m${i}`, kind: "message", role: i % 2 ? "agent" : "user", text: `transcript line ${i}`, complete: true, ts: "1" })),
      { id: "th1", kind: "thought", text: "weighing the plan", complete: true, ts: "1" },
      { id: "tc1", kind: "tool_call", title: "write_file", status: "done", input: "in", output: "out", ts: "1" },
      { id: "ml1", kind: "mail", from: "router", to: "codex-1", body: "go build it now", ts: "1" },
    ], hasMore: true, oldestSeq: "m0" } },
    activity: [], mail: [], history: [],
    pending: [{ requestId: "rq1", agent: "router", question: "write config.json?", options: [{ id: "allow", name: "Allow" }, { id: "deny", name: "Deny" }], ts: "1" }],
    modes: { router: { current: "default", available: [{ id: "default", name: "default" }, { id: "plan", name: "plan" }] } },
    models: { router: { current: "opus-4.8", available: [{ id: "opus-4.8", name: "Opus 4.8" }] } },
    efforts: { router: { configId: "c", current: "high", available: [{ id: "high", name: "high" }, { id: "low", name: "low" }] } },
    capabilities: {}, usage: {}, health: {}, selfAwareness: {},
    queues: { router: { count: 1, items: [{ id: "q1", source: "operator", preview: "queued prompt", ts: "1" }] } },
    board: null,
  } },
};
// 5 meshes → the desktop left-nav pager (#19) appears (4/page).
const SEED_PAGES = {
  meshes: ["demo", "alpha", "beta", "gamma", "delta"].map((name) => ({ name, defined: true, status: "stopped", router: "router", agents: [{ id: "router", harness: "claude", role: "router", status: "cold", activity: "idle" }], edges: [] })),
  assistant: { status: "absent", transcript: [] },
  perMesh: {},
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
// Seed the diagnostics run dir so the REAL doctor/ps path returns deterministic recovery
// fixtures: a live daemon (record → this alive pid) + an orphan socket (leak with no owner).
const RUN_DIR = join(auth.authRoot, "run");
mkdirSync(RUN_DIR, { recursive: true });
await writeRecord(RUN_DIR, { name: "dev-mesh", pid: process.pid, socketPath: join(RUN_DIR, "dev-mesh.sock"), proto: 2, startedAt: new Date(Date.now() - 3_600_000).toISOString() });
writeFileSync(join(RUN_DIR, "dev-mesh.sock"), "");
writeFileSync(join(RUN_DIR, "old-mesh.sock"), ""); // orphan socket → a reapable leak
// Seed the notification center (the gateway sync-loads <root>/notifications.json at construction)
// so the snapshot carries 2 unread + 1 read for the topbar badge + page tests.
const NOW = Date.now();
writeFileSync(join(auth.authRoot, "notifications.json"), JSON.stringify({
  version: 1, revision: 3, seq: 3, notifications: [
    { id: "ntf-3", type: "harness-upgrade", severity: "warning", title: "codex 有更新 v1.2.3 → v1.2.5", body: "在 Harnesses 面板更新", createdAt: new Date(NOW - 120000).toISOString(), dedupKey: "harness-upgrade:codex:1.2.5", source: { surface: "harnesses" } },
    { id: "ntf-2", type: "device-auth", severity: "info", title: "新设备申请授权", createdAt: new Date(NOW - 600000).toISOString(), dedupKey: "device-auth:dev-x", source: { surface: "settings", tab: "devices" } },
    { id: "ntf-1", type: "system-alert", severity: "info", title: "auto-compact 已触发", createdAt: new Date(NOW - 3600000).toISOString(), readAt: new Date(NOW - 3500000).toISOString(), dedupKey: "system:compact" },
  ],
}));
const gw = new WebGateway(fakeManager() as any, asstStub as any, { root: auth.authRoot });
const handle = startWebServer({ gateway: gw, port: 0, dev: false }); // no HMR (prod-like serving)
const BASE = handle.url;
const browser = await launchChromium();
const errors: string[] = [];
let passed = 0;
const step = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

try {
  const ctx = await authedContext(browser, auth.token, { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  // 7.5-C error-boundary test deliberately throws (test seam); ignore that error + React's
  // boundary console noise about it so the run's real-error gate stays meaningful.
  const ignoredPageError = (s: string) => /forced surface error|The above error occurred|MaybeThrow|recreate this component tree/i.test(s);
  page.on("pageerror", (e) => { const s = String(e); if (!ignoredPageError(s)) errors.push(s); });
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|_bun\/hmr/.test(m.text()) && !ignoredPageError(m.text())) errors.push(m.text()); });

  await step("/bnw/ mounts the new shell + lands on default mesh runtime", async () => {
    await page.goto(`${BASE}/bnw/`, { waitUntil: "domcontentloaded" });
    // i18n: the product default is English; this legacy suite asserts the Chinese shell labels,
    // so preseed zh once for the whole run (persists in localStorage; the dedicated i18n step
    // drives en↔zh explicitly and restores zh). Set after origin is established, then reload.
    await page.evaluate(() => { localStorage.setItem("mesh.lang", "zh"); });
    await page.reload({ waitUntil: "domcontentloaded" });
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

  await step("7.4-A.2b-ii file-viewer: markdown/code/image + lightbox + back + 404 (Bearer fetch)", async () => {
    // Stub the gated agent-file / artifact fetches so the viewer renders deterministic content.
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await page.route("**/api/agents/router/files/report.md", (r) => r.fulfill({ status: 200, contentType: "text/markdown", body: "# Gate summary\n\nThe device-auth gate is ready.\n" }));
    await page.route("**/api/agents/router/files/server.ts", (r) => r.fulfill({ status: 200, contentType: "text/plain", body: "export const answer = 42;\n" }));
    await page.route("**/api/agents/router/files/missing.md", (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "agent file not found" } }) }));
    await page.route("**/api/meshes/demo/agents/router/artifacts/topology.png", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));

    // markdown
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router/file/report.md`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="file"]', { timeout: 8000 });
    await page.waitForSelector('[data-artifact-kind="markdown"]', { timeout: 8000 });
    if (await page.getByText("Gate summary").count() === 0) throw new Error("markdown body not rendered");
    await page.waitForSelector('[data-artifact-back]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-file-viewer-desktop.png`, fullPage: true });

    // code (plain mono pre per mockup 11)
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router/file/server.ts`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-artifact-kind="code"]', { timeout: 8000 });
    if (await page.getByText("export const answer = 42;").count() === 0) throw new Error("code body not rendered");

    // image → lightbox via ?lb=1 → close
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router/artifact/topology.png`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-artifact-image]', { timeout: 8000 });
    await page.locator('[data-artifact-image]').click();
    await page.waitForSelector('[data-artifact-lightbox]', { timeout: 8000 });
    assert(new URL(page.url()).search.includes("lb=1"), "lightbox is URL-addressable (?lb=1)");
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-file-viewer-lightbox-desktop.png`, fullPage: true });
    await page.locator('[aria-label="close lightbox"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-artifact-lightbox]'), { timeout: 8000 });

    // 404 → not found + back affordance
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router/file/missing.md`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-artifact="viewer"]', { timeout: 8000 });
    if (await page.getByText("File not found").count() === 0) throw new Error("404 state not rendered");
  });

  await step("7.4-A.2b-ii device-auth gate: unauth /bnw shows mockup-12 gate (code/bootstrap/remembered/?next)", async () => {
    // A fresh context with NO device token → bootAuthorized() probe (GET /api/state) 401s → the
    // /bnw BnwBoot replaces the console with the device-auth gate (real device/start issues a code).
    const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const ap = await anon.newPage();
      await ap.goto(`${BASE}/bnw/channels`, { waitUntil: "domcontentloaded" });
      await ap.waitForSelector('[data-device-auth="gate"]', { timeout: 8000 });
      await ap.waitForSelector('[data-device-code]', { timeout: 8000 });   // real device/start code
      await ap.waitForSelector('[data-bootstrap]', { timeout: 8000 });     // body-only bootstrap form
      await ap.waitForSelector('[data-remembered]', { timeout: 8000 });
      if (await ap.getByText("mesh device approve").count() === 0) throw new Error("host-CLI approve instruction missing");
      if (await ap.getByText("/bnw/channels").count() === 0) throw new Error("remembered deep-link not preserved");
      await sleep(120); await ap.screenshot({ path: `${SHOTS}/bnw-device-auth-desktop.png`, fullPage: true });
      // ?next is honored (open-redirect-guarded to /bnw)
      await ap.goto(`${BASE}/bnw/device-auth?next=/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
      await ap.waitForSelector('[data-remembered]', { timeout: 8000 });
      if (await ap.getByText("/bnw/mesh/demo").count() === 0) throw new Error("?next not remembered");
      // open-redirect guard: a non-/bnw ?next must NOT be honored (falls back to the current path)
      await ap.goto(`${BASE}/bnw/device-auth?next=https://evil.example/x`, { waitUntil: "domcontentloaded" });
      await ap.waitForSelector('[data-remembered]', { timeout: 8000 });
      if (await ap.getByText("evil.example").count() !== 0) throw new Error("open-redirect: external ?next must be rejected");
      // namespace guard: `/bnw.evil` look-alike (startsWith "/bnw" but outside the /bnw/ namespace) is rejected
      await ap.goto(`${BASE}/bnw/device-auth?next=/bnw.evil/x`, { waitUntil: "domcontentloaded" });
      await ap.waitForSelector('[data-remembered]', { timeout: 8000 });
      if (await ap.getByText("/bnw.evil").count() !== 0) throw new Error("namespace guard: /bnw.evil ?next must be rejected (strict isBnwPath)");
      // mobile shot
      await ap.setViewportSize({ width: 390, height: 844 });
      await ap.goto(`${BASE}/bnw/`, { waitUntil: "domcontentloaded" });
      await ap.waitForSelector('[data-device-code]', { timeout: 8000 });
      await sleep(120); await ap.screenshot({ path: `${SHOTS}/bnw-device-auth-mobile.png`, fullPage: true });
    } finally { await anon.close(); }
  });

  await step("7.4-B settings: real compose/applyComposition writes :root + persist; language/prefs; device placeholder", async () => {
    const cssVar = (name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
    const ls = (k: string) => page.evaluate((key) => localStorage.getItem(key), k);

    await page.goto(`${BASE}/bnw/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-settings="panel"]', { timeout: 8000 });
    await page.waitForSelector('[data-theme-matrix] [data-theme-cell]', { timeout: 8000 });
    assert(await page.locator('[data-theme-cell]').count() === 9, "9-combo live preview grid");
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-settings-appearance-desktop.png`, fullPage: true });

    // REAL theme apply (not preview-only): switch accent → :root --accent changes + persists.
    const accentBefore = await cssVar("--accent");
    await page.locator('[aria-label="apply dark-slate ember"]').click();
    await page.waitForFunction((prev) => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() !== prev, accentBefore, { timeout: 8000 });
    assert(await ls("mesh.theme.accent") === "ember", "accent persisted to localStorage");
    // switch mode via the segmented control → :root --surface changes + persists.
    const surfaceBefore = await cssVar("--surface");
    await page.getByRole("radio", { name: "Light·Cool" }).click();
    await page.waitForFunction((prev) => getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() !== prev, surfaceBefore, { timeout: 8000 });
    assert(await ls("mesh.theme.mode") === "light-cool", "mode persisted to localStorage");
    // custom palette: edit a token → live applyPalette writes :root --bg + persists custom.
    await page.locator('[data-custom-palette] summary').click();
    const bgInput = page.locator('[aria-label="palette bg"]');
    await bgInput.fill("#123456");
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase() === "#123456", { timeout: 8000 });
    assert(await ls("mesh.theme") === "custom", "custom palette marks active=custom");

    // language → persist + <html lang>
    await page.goto(`${BASE}/bnw/settings?tab=language`, { waitUntil: "domcontentloaded" });
    await page.getByRole("radio", { name: "English" }).click();
    await page.waitForFunction(() => document.documentElement.lang === "en", { timeout: 8000 });
    assert(await ls("mesh.lang") === "en", "language persisted");
    await sleep(80); await page.screenshot({ path: `${SHOTS}/bnw-settings-language-desktop.png`, fullPage: true });

    // prefs → client-local persist (no fake server write)
    await page.goto(`${BASE}/bnw/settings?tab=prefs`, { waitUntil: "domcontentloaded" });
    await page.getByRole("radio", { name: "看板" }).click();
    await page.waitForFunction(() => localStorage.getItem("mesh.bnw.defaultView") === "board", { timeout: 8000 });
    await sleep(80); await page.screenshot({ path: `${SHOTS}/bnw-settings-prefs-desktop.png`, fullPage: true });

    // devices → own-status (real) + honest host-CLI placeholder, no web approve/revoke
    await page.goto(`${BASE}/bnw/settings?tab=devices`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-device-mgmt]', { timeout: 8000 });
    assert(await page.locator('[data-device-mgmt] button').count() === 0, "device mgmt placeholder has no web action buttons");
    if (await page.getByText("mesh device list").count() === 0) throw new Error("host-CLI device guidance missing");
    await sleep(80); await page.screenshot({ path: `${SHOTS}/bnw-settings-devices-desktop.png`, fullPage: true });

    // reset all theme/pref keys so later steps + screenshots render the default theme; restore
    // the suite's zh language baseline (later legacy steps assert Chinese shell labels).
    await page.evaluate(() => {
      ["mesh.theme", "mesh.theme.custom", "mesh.theme.mode", "mesh.theme.accent", "mesh.lang", "mesh.bnw.defaultView", "mesh.bnw.defaultDevice"].forEach((k) => localStorage.removeItem(k));
      localStorage.setItem("mesh.lang", "zh");
    });
  });

  await step("7.4-C.2 notifications: topbar badge + list + mark-read/all + follow + synthetic frontend-update", async () => {
    // topbar 🔔 badge reflects the real folded unread count (≥2 seeded unread; the earlier
    // device-auth step legitimately adds more via its producer, so assert presence, not exact N).
    await page.goto(`${BASE}/bnw/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await page.waitForSelector('[aria-label="未读通知"]', { timeout: 8000 });
    assert((await page.locator('[aria-label="未读通知"]').textContent())?.trim() !== "0", "unread badge shows a non-zero count");

    await page.goto(`${BASE}/bnw/notifications`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-notifications="center"]', { timeout: 8000 });
    await page.waitForSelector('[data-notif-type="harness-upgrade"]', { timeout: 8000 });
    if (await page.getByText("历史 / 已读").count() === 0) throw new Error("read item not split into history");
    await page.waitForSelector('[aria-label="notification filters"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-notifications-desktop.png`, fullPage: true });

    // mark-all gates on GLOBAL unread: filter to a category with no unread (system-alert = only the
    // read auto-compact) — mark-all stays ENABLED because the server-global unread count is > 0.
    await page.locator('[aria-label="filter system-alert"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-notif-type="harness-upgrade"]')); // category filtered
    assert(!(await page.locator('[aria-label="mark all read"]').isDisabled()), "mark-all enabled despite filtered-empty unread (global unread > 0)");
    await page.locator('[aria-label="filter all"]').click();
    await page.waitForSelector('[data-notif-type="harness-upgrade"]', { timeout: 8000 });

    // mark one read → POST → WS update folds → that item's mark-read control disappears + count drops
    const readResp = page.waitForResponse((r) => /\/api\/notifications\/ntf-3\/read$/.test(r.url()) && r.request().method() === "POST", { timeout: 8000 });
    await page.locator('[aria-label="mark read ntf-3"]').click();
    await readResp;
    await page.waitForFunction(() => !document.querySelector('[aria-label="mark read ntf-3"]')); // moved to history

    // mark all read → POST → unread badge clears entirely
    const allResp = page.waitForResponse((r) => /\/api\/notifications\/read-all$/.test(r.url()) && r.request().method() === "POST", { timeout: 8000 });
    await page.locator('[aria-label="mark all read"]').click();
    await allResp;
    await page.waitForFunction(() => !document.querySelector('[aria-label="未读通知"]'));

    // synthetic frontend-update: a snapshot with a changed appVersion flips getUpgrade() → ephemeral row
    await page.evaluate(() => { const s = (window as any).__meshStore.getState(); (window as any).__meshStore.apply({ t: "snapshot", state: { ...s, appVersion: "frontend-test-next-build" } }); });
    await page.waitForSelector('[data-notif-type="frontend-update"]', { timeout: 8000 });
    await page.waitForSelector('[aria-label="reload for update"]', { timeout: 8000 });

    // follow action resolves via structured source → /bnw route (SPA nav), never an external URL
    await page.locator('[data-notif-type="harness-upgrade"] a', { hasText: "查看" }).first().click();
    await page.waitForFunction(() => location.pathname === "/bnw/harnesses");
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

  await step("7.2-A board: real read list/kanban/detail + C4 filter shell + filter nav", async () => {
    // the board arrives via the REAL fetch path (ensureBoardLoaded → readBoard) — no client seed.
    await page.goto(`${BASE}/bnw/mesh/demo/board`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-list]', { timeout: 8000 });
    for (const sel of ['[data-bnw-board-filters]', '[aria-label="search issues"]', '[data-bnw-filter-toggle]', '[aria-label="Board view"]', '[aria-label="sort"]']) {
      if (await page.locator(sel).count() === 0) throw new Error(`board filter element missing: ${sel}`);
    }
    if (await page.getByText("Add device-auth page").count() === 0) throw new Error("real board issue missing in /bnw board list");
    // open 筛选▾ and filter by status=open via the menu → URL nav + chip
    await page.locator('[data-bnw-filter-toggle]').click();
    await page.waitForSelector('[data-bnw-filter-menu]', { timeout: 8000 });
    await page.locator('[aria-label="status filter"]').selectOption("open");
    await page.waitForSelector('[data-bnw-chip]', { timeout: 8000 });
    if (!new URL(page.url()).search.includes("status=open")) throw new Error("status filter not reflected in URL");
    if (await page.getByText("Drop legacy theme").count() !== 0) throw new Error("done issue should be filtered out by status=open");
    // view switch → kanban (URL-driven)
    await page.goto(`${BASE}/bnw/mesh/demo/board?view=kanban`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-kanban]', { timeout: 8000 });
    // detail deep link
    await page.goto(`${BASE}/bnw/mesh/demo/board/issue/12`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-detail]', { timeout: 8000 });
    if (await page.getByText("Add device-auth page").count() === 0) throw new Error("board detail missing the issue title");
  });

  await step("7.2-B detail mutations reach the gateway with CAS (board.rev=4 + entity rev=1)", async () => {
    // #12: task revision = 1. board-level CAS = BOARD_DOC.revision (4).
    await page.goto(`${BASE}/bnw/mesh/demo/board/issue/12`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-detail]', { timeout: 8000 });
    await page.locator('[aria-label="task status"]').selectOption("in_progress");
    await waitCall("boardCommand:set_task_status:board=4:rev=1"); // CAS proof
    await page.locator('[aria-label="task priority"]').selectOption("urgent");
    await waitCall("boardCommand:set_task_priority:board=4:rev=1");
    await page.locator('[aria-label="task assignee"]').selectOption("router");
    await waitCall("boardCommand:assign_task:board=4:rev=1");
    await page.locator('[aria-label="subtask 12.1 status"]').selectOption("in_progress");
    await waitCall("boardCommand:set_subtask_status:board=4:rev=1"); // subtask entity rev=1
    await page.locator('[aria-label="dispatch task"]').click();
    await waitCall("boardCommand:dispatch_task:board=4:rev=1");
    await page.locator('[aria-label="comment input"]').fill("looks good");
    await page.locator('[aria-label="add comment"]').click();
    await waitCall("boardCommand:add_comment:board=4:rev=1");
    // close done (set_task_status) — two-click ConfirmButton
    await page.locator('[aria-label="close done"]').click(); await page.locator('[aria-label="close done"]').click();
    await waitCall("boardCommand:set_task_status:board=4:rev=1");
    // close cancelled on #9 (open)
    await page.goto(`${BASE}/bnw/mesh/demo/board/issue/9`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-detail]', { timeout: 8000 });
    await page.locator('[aria-label="close cancelled"]').click(); await page.locator('[aria-label="close cancelled"]').click();
    await waitCall("boardCommand:set_task_status:board=4:rev=1");
    // terminal #5: reopen (record_lifecycle_event)
    await page.goto(`${BASE}/bnw/mesh/demo/board/issue/5`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-detail]', { timeout: 8000 });
    await page.locator('[aria-label="reopen issue"]').click();
    await waitCall("boardCommand:record_lifecycle_event:board=4:rev=1");
  });

  await step("7.2-B create (#25) + label CRUD (#24) reach the gateway", async () => {
    await page.goto(`${BASE}/bnw/mesh/demo/board`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-list]', { timeout: 8000 });
    // create task + create epic (structural — no entity rev)
    await page.locator('[aria-label="new issue"]').click();
    await page.waitForSelector('[data-bnw-board-create]', { timeout: 8000 });
    await page.locator('[aria-label="new task"]').fill("wire api fallback");
    await page.locator('[aria-label="create task"]').click();
    await waitCall("boardCommand:create_task:board=4:rev=-");
    await page.locator('[aria-label="new epic"]').fill("hardening");
    await page.locator('[aria-label="create epic"]').click();
    await waitCall("boardCommand:create_epic:board=4:rev=-");
    // label CRUD: create / recolor(update) / delete
    await page.locator('[aria-label="manage labels"]').click();
    await page.waitForSelector('[data-bnw-board-labels]', { timeout: 8000 });
    await page.locator('[aria-label="new label name"]').fill("infra");
    await page.locator('[aria-label="add label"]').click();
    await waitCall("boardCommand:create_label");
    await page.locator('[aria-label="recolor ui"] button').first().click(); // update_label (color)
    await waitCall("boardCommand:update_label");
    await page.locator('[aria-label="delete ui"]').click(); await page.locator('[aria-label="delete ui"]').click(); // ConfirmButton
    await waitCall("boardCommand:delete_label");
  });

  await step("7.2-B kanban drag→set_status + fullscreen + filter-context preservation", async () => {
    // kanban DnD: drop card #12 (in_review) onto the done column → set_task_status
    await page.goto(`${BASE}/bnw/mesh/demo/board?view=kanban`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-kanban]', { timeout: 8000 });
    await page.evaluate(() => {
      const col = document.querySelector('[data-bnw-kanban-col="done"]')!;
      const dt = new DataTransfer(); dt.setData("text/bnw-task", "12");
      col.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await waitCall("boardCommand:set_task_status:board=4:rev=1");
    // #22 fullscreen toggle
    await page.goto(`${BASE}/bnw/mesh/demo/board`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-list]', { timeout: 8000 });
    await page.locator('[aria-label="fullscreen"]').click();
    await page.waitForSelector('[data-bnw-board-fs]', { timeout: 8000 });
    await page.locator('[aria-label="exit fullscreen"]').click();
    if (await page.locator('[data-bnw-board-fs]').count() !== 0) throw new Error("exit fullscreen failed");
    // filter context preservation: row link keeps the query; detail back-link restores it
    await page.goto(`${BASE}/bnw/mesh/demo/board?status=open&label=ui`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-list]', { timeout: 8000 });
    await page.locator('[data-bnw-board-list] a').first().click();
    await page.waitForSelector('[data-bnw-board-detail]', { timeout: 8000 });
    const detailUrl = new URL(page.url());
    if (!(detailUrl.searchParams.get("status") === "open" && detailUrl.searchParams.get("label") === "ui")) throw new Error(`detail URL dropped the filter query: ${page.url()}`);
    await page.getByRole("link", { name: "◀" }).first().click(); // ◀ back (in the panel header)
    await page.waitForSelector('[data-bnw-board-list]', { timeout: 8000 });
    const backUrl = new URL(page.url());
    if (!(backUrl.searchParams.get("status") === "open" && backUrl.searchParams.get("label") === "ui")) throw new Error(`back link dropped the filter query: ${page.url()}`);
  });

  await step("7.3 new-mesh: real defineMesh + focus-trap editor + add-agent; assistant promptAssistant", async () => {
    // new-mesh create → real defineMesh
    await page.goto(`${BASE}/bnw/mesh/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-newmesh]', { timeout: 8000 });
    await page.locator('[aria-label="mesh name"]').fill("e2e-mesh");
    await page.locator('[aria-label="agent 1 id"]').fill("router");
    await page.locator('[aria-label="agent 1 project"]').fill("~/projects/app");
    // #2 expanded editor (focus-trap dialog)
    await page.locator('[aria-label="expand agent 1 instructions"]').click();
    await page.waitForSelector('[data-bnw-editor][role="dialog"]', { timeout: 8000 });
    await page.locator('[aria-label="close editor"]').click();
    // C3 add-agent (row appended)
    await page.locator('[aria-label="add agent"]').click();
    await page.waitForSelector('[aria-label="agent 2 id"]', { timeout: 8000 });
    await page.locator('[aria-label="agent 2 id"]').fill("codex-1");
    await page.locator('[aria-label="agent 2 project"]').fill("~/projects/app");
    await page.locator('[data-bnw-newmesh-actionbar] [aria-label="save mesh"]').click();
    await waitCall("defineMesh:e2e-mesh");
    // assistant → real promptAssistant + fullscreen
    await page.goto(`${BASE}/bnw/assistant`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-assistant="panel"]', { timeout: 8000 });
    await page.locator('[aria-label="assistant input"]').fill("build an app mesh");
    await page.getByRole("button", { name: "Send" }).click();
    await waitCall("assistantPrompt:build an app mesh");
    await page.goto(`${BASE}/bnw/assistant?full=1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-assistant="full"]', { timeout: 8000 });
  });

  // ── user-review screenshots (<=1500 wide, in artifacts) ──
  await step("7.1 focus-layout correction: single `<agent> · activity` context, queue chip, no stub", async () => {
    // overview must NOT render the old generic context stub
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    if (await page.getByText("上下文面板将随各表面接线填充").count() !== 0) throw new Error("overview still shows the generic context stub");
    // focus: exactly one right context panel, queue chip at top, no stub
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-focus="split"]', { timeout: 8000 });
    await page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_FOCUS);
    await page.waitForSelector('[data-bnw-context]', { timeout: 8000 });
    if (await page.locator('[data-bnw-context]').count() !== 1) throw new Error("focus must have exactly one context panel");
    if (await page.getByText("router · 活动").count() === 0) throw new Error("context panel title `<agent> · activity` missing"); // t(activity) @ zh
    if (await page.getByText("上下文面板将随各表面接线填充").count() !== 0) throw new Error("focus still shows the generic context stub");
    await page.waitForSelector('[data-bnw-queue-chip]', { timeout: 8000 }); // queue is a top chip
    if (await page.locator('[data-bnw-approval]').count() === 0) throw new Error("C2 docked approval bar must remain above the composer");
  });

  await step("7.4-A.2b-i channels: real status/bindings/sync/ensure/provision wired; auth-admin placeholders", async () => {
    // gw.feishuChannel() is absent in the fake gateway → intercept the feishu API at the browser
    // so the surface paints a configured/running channel with bindings (Option B scope).
    const STATUS = { state: "running", configPath: "channels/feishu.json", configured: true, enabled: true, appId: "cli_demo", domain: "feishu", bindings: [{ mesh: "demo", chatId: "oc_demo123", name: "demo 群", source: "auto", requireMention: true }], updatedAt: "" };
    await page.route("**/api/channels/feishu/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(STATUS) }));
    await page.route("**/api/channels/feishu/sync", (r) => { rec("feishu:sync"); return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ mesh: "demo", chatId: "oc_demo123", ok: true, created: false }]) }); });
    await page.route("**/api/channels/feishu/meshes/demo/group", (r) => { rec("feishu:ensure:demo"); return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mesh: "demo", chatId: "oc_demo123", ok: true, created: true }) }); });
    await page.route("**/api/channels/feishu/provision", (r) => { rec("feishu:provision"); return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "job-f1", state: "waiting", createdAt: "", updatedAt: "", verificationUrl: "https://open.feishu.cn/verify?t=demo", expireIn: 272 }) }); });
    await page.route("**/api/channels/feishu/provision/job-f1", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "job-f1", state: "waiting", createdAt: "", updatedAt: "", verificationUrl: "https://open.feishu.cn/verify?t=demo", expireIn: 260 }) }));
    await page.route("**/api/channels/feishu/provision/job-f1/cancel", (r) => { rec("feishu:cancel"); return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "job-f1", state: "cancelled", createdAt: "", updatedAt: "" }) }); });

    await page.goto(`${BASE}/bnw/channels`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-channels="panel"]', { timeout: 8000 });
    await page.waitForSelector('[data-channel-status]', { timeout: 8000 });
    await page.waitForSelector('[data-bindings] [data-binding]', { timeout: 8000 });
    // Option B: auth-admin sections are explicit placeholders — present, but NO approve/revoke actions
    await page.waitForSelector('[data-pending-senders]', { timeout: 8000 });
    await page.waitForSelector('[data-authorized-senders]', { timeout: 8000 });
    assert(await page.locator('[data-pending-senders] button, [data-authorized-senders] button').count() === 0, "auth-admin placeholders have no action buttons");
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-channels-desktop.png`, fullPage: true });

    // sync + ensure-group reach the backend
    const syncResp = page.waitForResponse((r) => r.url().includes("/api/channels/feishu/sync") && r.request().method() === "POST", { timeout: 8000 });
    await page.locator('[aria-label="sync feishu groups"]').click();
    await syncResp; await waitCall("feishu:sync");
    const ensureResp = page.waitForResponse((r) => r.url().includes("/api/channels/feishu/meshes/demo/group") && r.request().method() === "POST", { timeout: 8000 });
    await page.locator('[aria-label="ensure group demo"]').click();
    await ensureResp; await waitCall("feishu:ensure:demo");

    // provision (bind) → QR/verify card appears (poll) → cancel reaches backend
    await page.locator('[aria-label="bind chat to mesh"]').click();
    await waitCall("feishu:provision");
    await page.waitForSelector('[data-provision]', { timeout: 8000 });
    const cancelResp = page.waitForResponse((r) => r.url().includes("/api/channels/feishu/provision/job-f1/cancel") && r.request().method() === "POST", { timeout: 8000 });
    await page.locator('[aria-label="cancel provision"]').click();
    await cancelResp; await waitCall("feishu:cancel");
  });

  await step("7.4-A.2a harnesses: probe/reprobe/install-stream/respawn wired (stubbed probe)", async () => {
    // The harness probe hits the REAL probeHarnesses (host-dependent); intercept at the browser
    // so the surface paints deterministic rows + recovery state (same approach as harness-ui.e2e).
    const HROWS = [
      { id: "claude", label: "Claude", installed: true, version: "1.4.2", toolVersion: "0.141.0", latest: "1.4.2", outdated: false, auth: "ok", installable: "npm", lastProbeAt: 0, runningAgentsUsingOldVersion: [] },
      { id: "codex", label: "Codex", installed: true, version: "1.2.3", toolVersion: "0.140.0", latest: "1.2.5", outdated: true, auth: "required", installable: "npm", lastProbeAt: 0, runningAgentsUsingOldVersion: ["demo/codex-1"] },
      { id: "opencode", label: "OpenCode", installed: false, auth: "unknown", installable: "self", installHint: { command: "npm i -g opencode", docsUrl: "https://opencode.example/docs" }, lastProbeAt: 0, runningAgentsUsingOldVersion: [] },
      { id: "kimi", label: "Kimi", installed: true, auth: "unknown", installable: "self", installHint: { command: "npm i -g @moonshot/kimi", docsUrl: "https://kimi.example/docs" }, lastProbeAt: 0, runningAgentsUsingOldVersion: [] },
    ];
    await page.route("**/api/harnesses", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HROWS) }));
    await page.route("**/api/harnesses/codex/install", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-1", status: "running", harnessId: "codex", pkgSpec: "codex-acp@1.2.5" }) }));
    await page.route("**/api/harnesses/codex/install/job-1/stream", (r) => r.fulfill({ status: 200, contentType: "application/x-ndjson", body: [JSON.stringify({ step: "fetch", harnessId: "codex", pkgSpec: "codex-acp@1.2.5", stdoutLine: "fetching codex-acp@1.2.5" }), JSON.stringify({ step: "done", harnessId: "codex", pkgSpec: "codex-acp@1.2.5", installedVersion: "1.2.5" })].join("\n") }));
    await page.route("**/api/harnesses/*/reprobe", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
    await page.route("**/api/meshes/demo/agents/codex-1/respawn", (r) => { const b = JSON.parse(r.request().postData() || "{}"); rec(`respawn:demo:codex-1:${b.mode}`); return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode: b.mode, scheduled: b.mode === "after-idle" }) }); });

    await page.goto(`${BASE}/bnw/harnesses`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-harnesses="panel"]', { timeout: 8000 });
    await page.waitForSelector('[data-harness-row]', { timeout: 8000 });
    assert(await page.locator('[data-harness-row]').count() === 4, "4 harness rows render");
    await page.waitForSelector('[aria-label="update codex"]', { timeout: 8000 }); // outdated npm → update CTA
    await page.waitForSelector('[data-self-installer]', { timeout: 8000 });       // self-install guide (opencode/kimi)
    await page.waitForSelector('[data-old-agents] [data-old-agent]', { timeout: 8000 }); // old-version agent
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-harnesses-desktop.png`, fullPage: true });

    // reprobe → POST /reprobe
    const reprobeResp = page.waitForResponse((r) => r.url().includes("/api/harnesses/codex/reprobe") && r.request().method() === "POST", { timeout: 8000 });
    await page.locator('[aria-label="reprobe codex"]').click();
    await reprobeResp;

    // update → install POST + NDJSON stream → live progress card → done → close (#26)
    const installResp = page.waitForResponse((r) => r.url().includes("/api/harnesses/codex/install") && r.request().method() === "POST", { timeout: 8000 });
    await page.locator('[aria-label="update codex"]').click();
    await installResp;
    await page.waitForSelector('[data-install-progress]', { timeout: 8000 });
    await page.waitForSelector('[aria-label="close install progress"]', { timeout: 8000 }); // reached done
    await page.locator('[aria-label="close install progress"]').click();

    // restart old-version agent (after-idle) → respawn reaches the backend (#28)
    await page.locator('[aria-label="restart demo/codex-1 after idle"]').click();
    await waitCall("respawn:demo:codex-1:after-idle");
  });

  await step("7.4-A doctor: real fetchDoctor+fetchPsDetail; reap orphan + restart daemon reach backend", async () => {
    await page.goto(`${BASE}/bnw/doctor`, { waitUntil: "domcontentloaded" });
    // wired (not placeholder): the summary only renders once fetchDoctor + fetchPsDetail resolve
    await page.waitForSelector('[data-doctor-summary]', { timeout: 8000 });
    await page.waitForSelector('[data-doctor-findings]', { timeout: 8000 });
    // seeded live daemon (record → this alive pid) → ps row with a restart control
    await page.waitForSelector('[aria-label="restart daemon dev-mesh"]', { timeout: 8000 });
    // seeded orphan socket → a reapable leak row in the recovery panel
    await page.waitForSelector('[data-recovery] [data-leak]', { timeout: 8000 });
    assert(await page.locator('[data-leak]').count() >= 1, "orphan leak row present before reap");
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-doctor-desktop.png`, fullPage: true });

    // reap all → POST /api/diagnostics/reap → orphan leak removed; the live daemon is never touched
    const reapResp = page.waitForResponse((r) => r.url().includes("/api/diagnostics/reap") && r.request().method() === "POST", { timeout: 8000 });
    await page.locator('[aria-label="reap all orphans"]').click();
    await reapResp;
    await page.waitForFunction(() => document.querySelectorAll("[data-leak]").length === 0, { timeout: 8000 });
    assert(await page.locator('[aria-label="restart daemon dev-mesh"]').count() === 1, "live daemon survived the reap (reapLeaks skips live pids)");

    // restart daemon → stop+start reach the manager (existing approved lifecycle APIs)
    await page.locator('[aria-label="restart daemon dev-mesh"]').click();
    await waitCall("stopMesh:dev-mesh");
    await waitCall("startMesh:dev-mesh");
  });

  // 7.5-A — mobile shell: bottom tabs (运行态/看板/更多), mesh <select>, no desktop side rails.
  await step("mobile shell: bottom tabs + mesh select + 更多 overlay (no desktop rails)", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    // desktop left mesh nav + mesh sub-nav are fully hidden at 390px
    assert(!(await page.locator('nav[aria-label="meshes"]').isVisible()), "left mesh nav must be hidden on mobile");
    assert(await page.locator('[data-bnw-bottomtabs]').isVisible(), "bottom tabs must show on mobile");
    assert(await page.locator('[aria-label="选择 mesh"]').isVisible(), "mobile mesh select must show");
    // bottom tab: 看板 → board surface
    await page.locator('[data-bnw-bottomtabs] [aria-label="看板"]').click();
    await page.waitForSelector('[data-bnw-surface="board"]', { timeout: 8000 });
    // bottom tab: 运行态 → back to runtime
    await page.locator('[data-bnw-bottomtabs] [aria-label="运行态"]').click();
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    // 更多 → full-screen management list; tapping a row navigates + closes the overlay
    await page.locator('[data-bnw-more-toggle]').click();
    await page.waitForSelector('[data-bnw-more]', { timeout: 8000 });
    await page.locator('[data-bnw-more] a', { hasText: "设置" }).click();
    await page.waitForSelector('[data-bnw-surface="settings"]', { timeout: 8000 });
    assert(!(await page.locator('[data-bnw-more]').isVisible()), "更多 overlay must close after navigating");
    // mesh select switches the active mesh (preserves runtime)
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await page.locator('[aria-label="选择 mesh"]').selectOption("alpha");
    await page.waitForFunction(() => location.pathname === "/bnw/mesh/alpha", { timeout: 8000 });
    // desktop sanity: at 1440 the bottom tabs hide and the left nav returns
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    assert(await page.locator('nav[aria-label="meshes"]').isVisible(), "left mesh nav must show on desktop");
    assert(!(await page.locator('[data-bnw-bottomtabs]').isVisible()), "bottom tabs must hide on desktop");
  });

  // 7.5-C — global states (surface 13): in-app 404, stage ErrorBoundary, offline/reconnect.
  await step("7.5-C global states: in-app 404 + stage ErrorBoundary (crash contained + recover)", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // in-app SPA 404 for an unknown /bnw route — shell chrome stays, not-found card shows
    await page.goto(`${BASE}/bnw/no-such-surface`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-not-found]', { timeout: 8000 });
    assert(await page.locator('header').first().isVisible(), "topbar must survive a 404");
    await page.locator('[data-bnw-not-found] a', { hasText: "返回控制台" }).click();
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });

    // stage ErrorBoundary: force a surface crash → error card shows, topbar/nav survive.
    // SPA-navigate (pushState+popstate) so `window` — and the test flag — persists; a full
    // page goto would reset window and clear the flag.
    await page.evaluate(() => {
      (window as any).__bnwForceError = true;
      history.pushState({}, "", "/bnw/doctor");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.waitForSelector('[data-bnw-error-boundary]', { timeout: 8000 });
    assert(await page.locator('header').first().isVisible(), "topbar must survive a surface crash");
    assert(await page.locator('nav[aria-label="management"]').isVisible(), "management nav must survive a surface crash");
    // retry recovers once the (test) error condition clears
    await page.evaluate(() => { (window as any).__bnwForceError = false; });
    await page.locator('[data-bnw-error-boundary] [aria-label="retry surface"]').click();
    await page.waitForSelector('[data-doctor="panel"]', { timeout: 8000 });
    assert(await page.locator('[data-bnw-error-boundary]').count() === 0, "error card must clear after retry");
  });

  await step("7.5-C offline/reconnect: shell banner shows when WS is down (transient)", async () => {
    // a dedicated context whose WS connections are dropped → the store stays disconnected and
    // the unified shell offline banner renders (REST boot probe still mounts the app).
    const offCtx = await authedContext(browser, auth.token, { viewport: { width: 1440, height: 900 } });
    try {
      const op = await offCtx.newPage();
      await op.routeWebSocket(/\/ws/, (ws) => { ws.close(); });
      await op.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
      await op.waitForSelector('[data-bnw-offline]', { timeout: 8000 });
      assert(await op.locator('[data-bnw-offline] [aria-label="reconnect now"]').isVisible(), "offline banner must offer reconnect");
      await sleep(120); await op.screenshot({ path: `${SHOTS}/bnw-offline-desktop.png`, fullPage: true });
      await op.setViewportSize({ width: 390, height: 844 });
      await sleep(120); await op.screenshot({ path: `${SHOTS}/bnw-offline-mobile.png`, fullPage: true });
    } finally { await offCtx.close(); }
  });

  // 7.5-D — consolidated parity regression: coverage/14 all 28 [E] abilities + C1–C5 review
  // constraints, each asserted as a present /bnw control/marker (presence-gate; the full
  // mutation flows live in their own 7.1–7.4 steps — this consolidates so a regression can't
  // silently drop a control). Decision #5: consolidate + assert, do not re-drive 28 flows.
  await step("7.5-D parity regression: coverage/14 ×28 + C1–C5", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const has = async (sel: string, id: string) => assert(await page.locator(sel).count() > 0, `parity ${id}: ${sel}`);

    // ── new-mesh (04): #1–#8 ──────────────────────────────────────────────────
    await page.goto(`${BASE}/bnw/mesh/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-newmesh]', { timeout: 8000 });
    await page.locator('[aria-label="add agent"]').click(); // need ≥2 agents to add an edge
    await page.locator('[aria-label="agent 2 harness"]').selectOption("opencode"); // reveal #6 on agent 2
    await page.locator('[aria-label="add edge"]').click(); // reveal #8
    await has('[aria-label="agent 1 instructions"]', "#1 per-agent instructions");
    await has('[aria-label="expand agent 1 instructions"]', "#2 expanded editor (instructions)");
    await has('[aria-label="expand charter"]', "#2 expanded editor (charter)");
    await has('[aria-label="agent 1 model"]', "#3 per-agent model");
    await has('[aria-label="agent 1 effort"]', "#4 per-agent effort"); // claude supports effort
    await has('[aria-label="agent 1 lazy"]', "#5 lazy");
    await has('[aria-label="agent 2 opencode permission"]', "#6 opencode permission");
    await has('[aria-label="auto-compact enabled"]', "#7 auto-compact toggle");
    await has('[aria-label="auto-compact threshold"]', "#7 auto-compact threshold");
    await has('[aria-label="edge 1 steer"]', "#8 mail-edge steer");
    // C3 — long-form: mobile fixed Save footer keeps Create reachable
    await page.setViewportSize({ width: 390, height: 844 });
    await has('[data-bnw-newmesh-footer] [aria-label="save mesh"]', "C3 sticky mobile Save footer");
    await page.setViewportSize({ width: 1440, height: 900 });

    // ── runtime overview (02): #11 #12 #18 ───────────────────────────────────
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await has('[aria-label="start strategy"]', "#18 start-strategy select (stopped)");
    await page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_PARITY_OVERVIEW);
    await page.waitForSelector('[aria-label="wake lazy-1"]', { timeout: 8000 });
    await has('[aria-label="wake lazy-1"]', "#11 wake cold agent");
    await has('[aria-label="new all sessions demo"]', "#18 new-all-sessions (running)");
    await has('text=near_limit', "#12 near-limit health warning");
    await has('text=静默完成', "#12 silent-complete badge");
    await has('text=上下文', "#12 context usage chip"); // t(bnw.rt.context) @ zh (suite preseeds zh)

    // ── runtime focus (02): #9 #10 #13 #14 #15 + C2 ──────────────────────────
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-focus="split"]', { timeout: 8000 });
    // The store marks a transcript "loaded" only when loadInitialTranscript resolves (and only
    // when hasMore + a ready agent / fetched items). Apply the seed (ready router + hasMore +
    // items), explicitly run loadInitial (marks loaded, but sets hasMore=false), then re-apply
    // the seed so hasMore is restored for the load-older control while the loaded marker sticks.
    await page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_PARITY_FOCUS);
    await page.evaluate(() => (window as any).__meshStore.loadInitialTranscript("demo", "router"));
    await page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_PARITY_FOCUS);
    await page.waitForSelector('[data-bnw-expand]', { timeout: 8000 }); // items rendered (loaded)
    await has('[href*="full=1"]', "#9 session fullscreen toggle");
    await has('[aria-label="router mode"]', "#10 mode selector");
    await has('[aria-label="router model"]', "#10 model selector");
    await has('[aria-label="router effort"]', "#10 effort selector");
    await has('[data-bnw-queue-chip]', "#13 pending-turns queue");
    await has('[data-bnw-expand]', "#14 transcript expand toggles");
    await has('text=载入更早', "#15 load-older transcript control");
    await has('[data-bnw-approval]', "C2 docked approval bar (focus)");
    // #15 jump-to-bottom appears after scrolling the transcript up
    await page.locator('[data-bnw-transcript]').evaluate((el) => { (el as HTMLElement).scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
    await page.waitForSelector('[data-bnw-jump]', { timeout: 8000 });
    await has('[data-bnw-jump]', "#15 jump-to-bottom");

    // ── canvas (02): #16 #17 + C5 ────────────────────────────────────────────
    await page.goto(`${BASE}/bnw/mesh/demo/canvas`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-canvas]', { timeout: 8000 });
    await page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_CANVAS);
    await page.waitForSelector('[data-bnw-node]', { timeout: 8000 });
    await has('[data-bnw-node]', "#16 zoomable topology canvas (nodes)");
    await has('[aria-label="add agent"]', "#17 live add agent");
    await has('[aria-label="add edge"]', "#17 live add edge");
    await page.waitForSelector('[data-edge-recent]', { state: "attached", timeout: 8000 });
    await has('[data-edge-recent]', "C5 information-flow edges (recent highlight)");
    await has('[aria-label="force-directed layout"]', "C5 force-directed layout");
    await has('[aria-label="重新布局"]', "C5 relayout");

    // ── app shell (01): #19 pagination (functional), #20 reload (functional) ──
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_PAGES); // 5 meshes → pager
    await page.waitForSelector('[data-bnw-mesh-pager]', { timeout: 8000 });
    const meshNav = page.locator('nav[aria-label="meshes"]');
    // #19 — page 1 shows page-1 meshes, hides page-2 (delta); next → delta visible; prev restores.
    assert(await meshNav.getByText("demo", { exact: true }).count() > 0, "#19 page 1 shows demo");
    assert(await meshNav.getByText("delta", { exact: true }).count() === 0, "#19 page 1 hides page-2 (delta)");
    await page.locator('[data-bnw-mesh-pager] [aria-label="next mesh page"]').click();
    await meshNav.getByText("delta", { exact: true }).waitFor({ timeout: 8000 });
    assert(await meshNav.getByText("delta", { exact: true }).count() > 0, "#19 next → delta (page 2) visible");
    assert(await meshNav.getByText("demo", { exact: true }).count() === 0, "#19 page 2 hides page-1 (demo)");
    await page.locator('[data-bnw-mesh-pager] [aria-label="previous mesh page"]').click();
    await meshNav.getByText("demo", { exact: true }).waitFor({ timeout: 8000 });
    assert(await meshNav.getByText("delta", { exact: true }).count() === 0, "#19 prev → page 1 restored");
    // #20/#7 — desktop reload opens the confirmation dialog → confirm → manager.reloadDefinitionsPreservingRuntime
    await meshNav.locator('[aria-label="reload mesh definitions"]').click();
    await page.waitForSelector('[data-bnw-reload-dialog]', { timeout: 8000 });
    await page.locator('[aria-label="confirm reload"]').click();
    await waitCall("reload");

    // ── assistant (05): #21 ──────────────────────────────────────────────────
    await page.goto(`${BASE}/bnw/assistant?full=1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-assistant="full"]', { timeout: 8000 });
    await has('[data-bnw-assistant="full"]', "#21 assistant fullscreen");

    // ── board (03): #22 #23 #24 #25 + C4 ─────────────────────────────────────
    await page.goto(`${BASE}/bnw/mesh/demo/board`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-list]', { timeout: 8000 });
    await has('[aria-label="fullscreen"]', "#22 board fullscreen");
    await has('[aria-label="manage labels"]', "#24 manage-labels CRUD");
    await page.locator('[data-bnw-filter-toggle]').click(); // #23 lives in the filter menu
    await has('[aria-label="group by epic"]', "#23 group-by-epic");
    await page.locator('[aria-label="new issue"]').click();
    await has('[aria-label="new task"]', "#25 create task");
    await has('[aria-label="new epic"]', "#25 create epic");
    // C4 — filter toolbar never overflows its container
    const board = page.locator('[aria-label="board filters"]');
    assert(await board.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "C4 board filter no horizontal overflow");
    await page.goto(`${BASE}/bnw/mesh/demo/board/issue/5`, { waitUntil: "domcontentloaded" }); // task 5 = done
    await page.waitForSelector('[data-bnw-board-detail]', { timeout: 8000 });
    await has('[aria-label="reopen issue"]', "#25 reopen closed task");

    // ── harnesses (06): #26 #27 #28 ──────────────────────────────────────────
    await page.goto(`${BASE}/bnw/harnesses`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-harness-row]', { timeout: 8000 });
    await has('[data-self-installer]', "#27 self-install guide (copy/docs/reprobe)");
    await has('[data-old-agents] [data-old-agent]', "#28 restart old-version agents (force/after-idle/cancel)");
    await has('[aria-label^="force restart"]', "#28 force restart");
    await has('[aria-label^="restart"][aria-label$="after idle"]', "#28 after-idle restart");
    // #26 install-progress: trigger codex's install stream (stubbed), assert the live log + close
    await page.locator('[aria-label="update codex"]').click();
    await page.waitForSelector('[data-install-progress]', { timeout: 8000 });
    await has('[data-install-progress]', "#26 install progress live log");
    await has('[aria-label="close install progress"]', "#26 install progress close");

    // ── C1 — mobile anti-pattern: shell stacks (bottom tabs, no desktop rails) ─
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-bottomtabs]', { timeout: 8000 });
    assert(await page.locator('[data-bnw-bottomtabs]').isVisible(), "C1 mobile bottom tabs");
    assert(!(await page.locator('nav[aria-label="meshes"]').isVisible()), "C1 desktop left rail hidden on mobile");
    // #20 (mobile) — reload lives in the 更多 menu; drive its two-click confirm → manager reload
    calls.length = 0;
    await page.locator('[data-bnw-more-toggle]').click();
    await page.waitForSelector('[data-bnw-more]', { timeout: 8000 });
    const mReload = page.locator('[data-bnw-more] [aria-label="reload mesh definitions (mobile)"]');
    assert(await mReload.count() > 0, "#20 mobile reload row in 更多");
    await mReload.click(); // opens the shared confirmation dialog (closes 更多)
    await page.waitForSelector('[data-bnw-reload-dialog]', { timeout: 8000 });
    await page.locator('[aria-label="confirm reload"]').click();
    await waitCall("reload");
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  // Composer textareas must fill their container width (mobile bug: textarea shrank to its
  // cols width in the composer's top-left). Assert the fill ratio on desktop and mobile.
  await step("composer textareas fill container width (runtime focus + assistant, desktop+mobile)", async () => {
    const fillRatio = (taSel: string) => page.locator(taSel).evaluate((ta) => {
      const group = (ta as HTMLElement).closest('[role="group"]') as HTMLElement;
      return (ta as HTMLElement).getBoundingClientRect().width / group.getBoundingClientRect().width;
    });
    for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const) {
      await page.setViewportSize(vp);
      await page.goto(`${BASE}/bnw/mesh/demo/agent/router`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[aria-label="message input"]', { timeout: 8000 });
      const r1 = await fillRatio('[aria-label="message input"]');
      assert(r1 > 0.85, `runtime composer textarea must fill width @${vp.width} (got ${r1.toFixed(2)})`);
      await page.goto(`${BASE}/bnw/assistant`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[aria-label="assistant input"]', { timeout: 8000 });
      const r2 = await fillRatio('[aria-label="assistant input"]');
      assert(r2 > 0.85, `assistant composer textarea must fill width @${vp.width} (got ${r2.toFixed(2)})`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  // Dev-note leak guard (user feedback #2): no implementation/slice/parity notes leak into
  // rendered /bnw UI. Curated patterns capture dev notes (接线于 / 7.x-Y / parenthesised #N)
  // WITHOUT flagging legitimate board issue IDs, which render bare ("#12", never "(#12)").
  await step("/bnw dev-note leak guard: no 接线于 / slice / parenthesised-#N leakage in rendered UI", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const BANNED = ["接线于", "7\\.[0-9]-[A-D]", "（#[0-9]+）", "\\(#[0-9]+\\)"];
    const surfaces: [string, string][] = [
      ["/bnw/mesh/demo", '[data-bnw-surface="runtime"]'],
      ["/bnw/mesh/demo/agent/router", '[data-bnw-focus="split"]'],
      ["/bnw/mesh/demo/canvas", '[data-bnw-canvas]'],
      ["/bnw/mesh/demo/board", '[data-bnw-board-list]'],
      ["/bnw/mesh/demo/board/issue/12", '[data-bnw-board-detail]'],
      ["/bnw/mesh/new", '[data-bnw-newmesh]'],
      ["/bnw/assistant", '[data-bnw-assistant="panel"]'],
      ["/bnw/harnesses", '[data-harness-row]'],
      ["/bnw/channels", '[data-channel-status]'],
      ["/bnw/doctor", '[data-doctor="panel"]'],
      ["/bnw/settings", '[data-theme-matrix]'],
      ["/bnw/notifications", '[data-notifications="center"]'],
      ["/bnw/mesh/demo/agent/router/file/report.md", '[data-artifact-kind="markdown"]'], // file/artifact viewer (stubbed md)
    ];
    const scan = async (p: import("playwright").Page, label: string) => {
      const hits = await p.evaluate((banned) => {
        const text = (document.body as HTMLElement).innerText;
        return banned.map((re) => (text.match(new RegExp(re)) ?? [])[0]).filter(Boolean);
      }, BANNED);
      assert(hits.length === 0, `dev-note leak on ${label}: ${hits.join(", ")}`);
    };
    for (const [path, sel] of surfaces) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(sel, { timeout: 8000 });
      await scan(page, path);
    }
    // device-auth gate (anonymous context replaces the console) — also leak-free
    const anonLeak = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const ap = await anonLeak.newPage();
      await ap.goto(`${BASE}/bnw/`, { waitUntil: "domcontentloaded" });
      await ap.waitForSelector('[data-device-auth="gate"]', { timeout: 8000 });
      await scan(ap, "/bnw/ (device-auth gate)");
    } finally { await anonLeak.close(); }
  });

  // #4 proposal — mobile runtime-focus compaction: one-line header + ⋯ controls disclosure.
  // Desktop must stay the existing inline horizontal layout. Light-theme screenshots (user
  // reported it there): desktop focus + mobile collapsed + mobile ⋯-expanded.
  await step("#4 mobile focus: compact header + ⋯ controls disclosure (desktop inline unchanged)", async () => {
    // desktop: selectors inline, no ⋯ overflow control
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-focus="split"]', { timeout: 8000 });
    await page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_PARITY_FOCUS);
    await page.waitForSelector('[aria-label="router mode"]', { timeout: 8000 });
    assert(await page.locator('[aria-label="router mode"]').isVisible(), "#4 desktop selectors inline visible");
    assert(!(await page.locator('[data-bnw-focus-more]').isVisible()), "#4 ⋯ overflow hidden on desktop");
    // mobile: compact header, ⋯ present, selectors collapsed until tapped
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.locator('[data-bnw-focus-more]').isVisible(), "#4 ⋯ shown on mobile");
    assert((await page.locator('[data-bnw-focus-controls]').count()) === 0, "#4 controls collapsed by default on mobile");
    assert(!(await page.locator('[aria-label="router mode"]').first().isVisible()), "#4 inline selectors hidden on mobile until ⋯");
    await page.locator('[data-bnw-focus-more]').click();
    await page.waitForSelector('[data-bnw-focus-controls]', { timeout: 8000 });
    assert(await page.locator('[data-bnw-focus-controls] [aria-label="router mode"]').isVisible(), "#4 ⋯ reveals stacked selectors");
    // light-theme proposal screenshots (desktop + mobile collapsed + mobile expanded)
    await page.evaluate(() => { localStorage.setItem("mesh.theme.mode", "light-cool"); localStorage.setItem("mesh.theme.accent", "signal-teal"); localStorage.removeItem("mesh.theme"); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-focus="split"]', { timeout: 8000 });
    await page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_PARITY_FOCUS);
    await page.waitForSelector('[aria-label="router mode"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-focus-desktop-light.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForSelector('[data-bnw-focus-more]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-focus-mobile-collapsed-light.png`, fullPage: true });
    await page.locator('[data-bnw-focus-more]').click();
    await page.waitForSelector('[data-bnw-focus-controls]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-focus-mobile-expanded-light.png`, fullPage: true });
    // restore default theme for the remaining steps
    await page.evaluate(() => { localStorage.removeItem("mesh.theme.mode"); localStorage.removeItem("mesh.theme.accent"); });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  // #5 fix (separate scope from #4) — root color-scheme follows the active mode's dark/light so
  // native controls (select arrow, scrollbars) are visible in dark mode.
  await step("#5 root color-scheme follows dark/light (native select arrows)", async () => {
    const scheme = () => page.evaluate(() => document.documentElement.style.colorScheme);
    // persisted dark mode → color-scheme dark on load
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { localStorage.setItem("mesh.theme.mode", "dark-slate"); localStorage.setItem("mesh.theme.accent", "signal-teal"); localStorage.removeItem("mesh.theme"); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    assert((await scheme()) === "dark", "#5 dark-slate → color-scheme dark");
    // light mode → light
    await page.evaluate(() => { localStorage.setItem("mesh.theme.mode", "light-cool"); localStorage.removeItem("mesh.theme"); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    assert((await scheme()) === "light", "#5 light-cool → color-scheme light");
    // live 3×3 switch via settings updates color-scheme without reload
    await page.goto(`${BASE}/bnw/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-theme-matrix] [data-theme-cell]', { timeout: 8000 });
    await page.locator('[aria-label="apply dark-slate signal-teal"]').click();
    assert((await scheme()) === "dark", "#5 live switch → dark");
    await page.locator('[aria-label="apply eye-care-warm ember"]').click();
    assert((await scheme()) === "light", "#5 live switch → light (eye-care)");
    // dark-mode screenshots showing native select controls
    await page.evaluate(() => { localStorage.setItem("mesh.theme.mode", "dark-slate"); localStorage.setItem("mesh.theme.accent", "signal-teal"); localStorage.removeItem("mesh.theme"); });
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-focus="split"]', { timeout: 8000 });
    await page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_PARITY_FOCUS);
    await page.waitForSelector('[aria-label="router mode"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-select-dark-focus-desktop.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/mesh/demo/board`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-list]', { timeout: 8000 });
    await page.locator('[data-bnw-filter-toggle]').click();
    await page.waitForSelector('[aria-label="status filter"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-select-dark-board-filters.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[aria-label="选择 mesh"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-select-dark-mobile-topbar.png`, fullPage: true });
    // restore default theme for the remaining steps
    await page.evaluate(() => { localStorage.removeItem("mesh.theme.mode"); localStorage.removeItem("mesh.theme.accent"); });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  // #6 — emoji icons replaced by the SVG Icon set: no raw icon-emoji in /bnw chrome, the
  // notification bell is an SVG with its accessible label preserved, icons inherit currentColor.
  await step("#6 SVG icon sweep: bell is SVG (labelled) + no raw icon-emoji in /bnw chrome", async () => {
    // curated icon-emoji that were swept (NOT board issue ids / plain text arrows kept as content)
    const ICON_EMOJI = ["🔔", "🧭", "💥", "🛰", "🔑", "🤝", "🧩", "📡", "🩺", "🏷", "🔍", "🗖", "🗕", "⛔", "💭", "📎", "📌", "🎉"];
    const scanEmoji = async (label: string) => {
      const hits = await page.evaluate((emojis) => emojis.filter((e) => (document.body as HTMLElement).innerText.includes(e)), ICON_EMOJI);
      assert(hits.length === 0, `raw icon-emoji on ${label}: ${hits.join(" ")}`);
    };
    // topbar bell = SVG, accessible label preserved (decorative svg inside the labelled link)
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    assert(await page.locator('[aria-label="通知"] svg').count() > 0, "#6 topbar bell is an SVG");
    assert(await page.locator('[aria-label="通知"]').isVisible(), "#6 notification accessible label preserved");
    await scanEmoji("runtime overview chrome");
    // notifications surface: type icons are SVG, no emoji
    await page.goto(`${BASE}/bnw/notifications`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-notifications="center"]', { timeout: 8000 });
    assert(await page.locator('[data-notif] svg').count() > 0, "#6 notification type icons are SVG");
    await scanEmoji("notifications");
    // board toolbar icons (search/tag/fullscreen) are SVG, no emoji
    await page.goto(`${BASE}/bnw/mesh/demo/board`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-list]', { timeout: 8000 });
    assert(await page.locator('[aria-label="manage labels"] svg').count() > 0, "#6 board manage-labels icon is SVG");
    await scanEmoji("board list");
    // mobile bottom-tab + 更多 nav icons are SVG, no emoji
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-bottomtabs]', { timeout: 8000 });
    assert(await page.locator('[data-bnw-bottomtabs] svg').count() >= 3, "#6 bottom-tab icons are SVG");
    await page.locator('[data-bnw-more-toggle]').click();
    await page.waitForSelector('[data-bnw-more]', { timeout: 8000 });
    assert(await page.locator('[data-bnw-more] svg').count() >= 7, "#6 更多 list icons are SVG");
    await scanEmoji("mobile shell + 更多");
    // dark-mode icon screenshots (icons inherit currentColor + stay visible)
    await page.evaluate(() => { localStorage.setItem("mesh.theme.mode", "dark-slate"); localStorage.setItem("mesh.theme.accent", "signal-teal"); localStorage.removeItem("mesh.theme"); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-more]', { timeout: 8000 }).catch(() => {});
    await page.waitForSelector('[data-bnw-bottomtabs]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-icons-dark-mobile-more.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/bnw/notifications`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-notifications="center"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-icons-dark-notifications.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-icons-dark-topbar.png`, fullPage: true });
    await page.evaluate(() => { localStorage.removeItem("mesh.theme.mode"); localStorage.removeItem("mesh.theme.accent"); });
  });

  // i18n foundation slice — shell/nav copy switches en↔zh immediately (no refresh) via the
  // settings language tab; refresh preserves the language + <html lang>; en-mode shell chrome
  // has no leftover hardcoded CJK (the hardcoding guard).
  await step("i18n shell: en↔zh live switch + persistence + no hardcoded CJK in chrome", async () => {
    const htmlLang = () => page.evaluate(() => document.documentElement.lang);
    // Explicit shell-chrome regions touched by this slice (NOT a page-wide scan — surface bodies
    // are intentionally untranslated this slice, so a broad regex would false-positive). Collect
    // each region's rendered text and assert no CJK leaks under en (technical Latin terms pass).
    const hasCJK = (s: string) => /[㐀-䶿一-鿿豈-﫿]/.test(s);
    const collect = (sels: string[]) => page.evaluate((ss) => ss
      .map((s) => { const el = document.querySelector(s) as HTMLElement | null; return el ? el.innerText : ""; })
      .join("\n"), sels);
    const DESKTOP_SHELL = ['header', 'nav[aria-label="meshes"]', 'nav[aria-label="management"]', 'main > div.mb-3'];
    const MOBILE_SHELL = ['header', '[data-bnw-bottomtabs]', '[data-bnw-more]'];

    // en default (clear the suite's preseeded zh for this check)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { localStorage.removeItem("mesh.lang"); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    assert((await htmlLang()) === "en", "i18n default <html lang> = en");
    assert(await page.locator('nav[aria-label="management"]').getByText("settings", { exact: true }).count() > 0, "i18n en: management shows English");
    // hardcoding guard (desktop chrome): topbar + desktop mesh nav + management nav + sub-nav
    const desktopShell = await collect(DESKTOP_SHELL);
    assert(!hasCJK(desktopShell), `i18n guard: CJK leaked in en desktop shell chrome: ${desktopShell.replace(/\s+/g, " ").slice(0, 120)}`);
    await sleep(80); await page.screenshot({ path: `${SHOTS}/bnw-i18n-shell-en.png`, fullPage: true });
    // hardcoding guard (mobile chrome): topbar + bottom tabs + open 更多 overlay
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-bottomtabs]', { timeout: 8000 });
    await page.locator('[data-bnw-more-toggle]').click();
    await page.waitForSelector('[data-bnw-more]', { timeout: 8000 });
    const mobileShell = await collect(MOBILE_SHELL);
    assert(!hasCJK(mobileShell), `i18n guard: CJK leaked in en mobile shell chrome: ${mobileShell.replace(/\s+/g, " ").slice(0, 120)}`);
    await page.setViewportSize({ width: 1440, height: 900 });

    // runtime body (this slice): overview lifecycle/usage app-copy + focus composer app-copy must
    // be English under en. Scan ONLY app-copy regions (NOT transcript/activity/mail/ids/user text).
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-lifecycle]', { timeout: 8000 });
    const overviewBody = await collect(['[data-bnw-lifecycle]']);
    assert(!hasCJK(overviewBody), `i18n guard: CJK in en runtime overview app-copy: ${overviewBody.replace(/\s+/g, " ").slice(0, 120)}`);
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[aria-label="Message composer"]', { timeout: 8000 });
    const composerEn = await collect(['[aria-label="Message composer"]']);
    assert(!hasCJK(composerEn), `i18n guard: CJK in en runtime composer app-copy: ${composerEn.replace(/\s+/g, " ").slice(0, 120)}`);
    assert(composerEn.includes("Send"), "i18n en: composer Send is English");
    await sleep(80); await page.screenshot({ path: `${SHOTS}/bnw-i18n-focus-en.png`, fullPage: true });

    // live switch en→zh via the settings language tab (no reload)
    await page.goto(`${BASE}/bnw/settings?tab=language`, { waitUntil: "domcontentloaded" });
    await page.getByRole("radio", { name: "中文" }).click();
    await page.waitForFunction(() => document.documentElement.lang === "zh", { timeout: 8000 });
    // shell (persistent across the surface) updated immediately — management nav now Chinese
    assert(await page.locator('nav[aria-label="management"]').getByText("设置", { exact: true }).count() > 0, "i18n live zh: management updates without refresh");

    // SPA-nav to a mesh route → sub-nav + tabs reflect zh (no reload)
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    assert((await htmlLang()) === "zh", "i18n zh persists across navigation");
    assert(await page.getByText("运行态", { exact: true }).count() > 0, "i18n zh: sub-nav 运行态");
    await sleep(80); await page.screenshot({ path: `${SHOTS}/bnw-i18n-shell-zh.png`, fullPage: true });
    // runtime body switched too — focus composer app-copy is now Chinese (发送)
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[aria-label="Message composer"]', { timeout: 8000 });
    assert((await collect(['[aria-label="Message composer"]'])).includes("发送"), "i18n zh: runtime composer 发送");
    await sleep(80); await page.screenshot({ path: `${SHOTS}/bnw-i18n-focus-zh.png`, fullPage: true });

    // refresh preserves language + <html lang>
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    assert((await htmlLang()) === "zh", "i18n zh preserved across refresh");
    assert(await page.locator('nav[aria-label="management"]').getByText("设置", { exact: true }).count() > 0, "i18n zh chrome after refresh");

    // round-trip back to en works immediately, then restore the suite's zh baseline for later steps
    await page.goto(`${BASE}/bnw/settings?tab=language`, { waitUntil: "domcontentloaded" });
    await page.getByRole("radio", { name: "English" }).click();
    await page.waitForFunction(() => document.documentElement.lang === "en", { timeout: 8000 });
    await page.evaluate(() => { localStorage.setItem("mesh.lang", "zh"); });
  });

  // #7 — reload control: explicit confirmation dialog (replaces two-click), desktop + mobile,
  // cancel once + confirm once; the real reload path still reaches manager.loadDefinitions.
  await step("#7 reload confirmation dialog: desktop + mobile, cancel + confirm → manager reload", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    // desktop: tooltip present on the reload trigger
    assert(((await page.locator('nav[aria-label="meshes"] [aria-label="reload mesh definitions"]').getAttribute("title")) ?? "").length > 0, "#7 reload trigger has a tooltip");
    // open → dialog shows title + body; cancel → no reload, dialog closes
    calls.length = 0;
    await page.locator('nav[aria-label="meshes"] [aria-label="reload mesh definitions"]').click();
    await page.waitForSelector('[data-bnw-reload-dialog]', { timeout: 8000 });
    assert(await page.locator('[data-bnw-reload-dialog]').getByText("重新加载 mesh 定义?").count() > 0, "#7 dialog title (zh suite)");
    assert(await page.locator('[data-bnw-reload-dialog]').getByText("meshes/*.json", { exact: false }).count() > 0, "#7 dialog body explains meshes/*.json");
    await page.locator('[aria-label="cancel reload"]').click();
    assert(await page.locator('[data-bnw-reload-dialog]').count() === 0, "#7 cancel closes the dialog");
    assert(!calls.some((c) => c.includes("reload")), "#7 cancel does NOT reload");
    await sleep(80); // screenshot the dialog open (desktop)
    await page.locator('nav[aria-label="meshes"] [aria-label="reload mesh definitions"]').click();
    await page.waitForSelector('[data-bnw-reload-dialog]', { timeout: 8000 });
    await page.screenshot({ path: `${SHOTS}/bnw-reload-dialog-desktop.png`, fullPage: true });
    await page.locator('[aria-label="confirm reload"]').click(); // confirm → real reload
    await waitCall("reload");
    // mobile: 更多 reload row opens the same dialog; screenshot + confirm
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-bottomtabs]', { timeout: 8000 });
    await page.locator('[data-bnw-more-toggle]').click();
    await page.waitForSelector('[data-bnw-more]', { timeout: 8000 });
    await page.locator('[data-bnw-more] [aria-label="reload mesh definitions (mobile)"]').click();
    await page.waitForSelector('[data-bnw-reload-dialog]', { timeout: 8000 });
    await sleep(80); await page.screenshot({ path: `${SHOTS}/bnw-reload-dialog-mobile.png`, fullPage: true });
    calls.length = 0;
    await page.locator('[aria-label="confirm reload"]').click();
    await waitCall("reload");
    await page.setViewportSize({ width: 1440, height: 900 });
  });

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
    // board list / kanban / detail + label manager (board via the real readBoard fetch)
    await page.goto(`${BASE}/bnw/mesh/demo/board`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-list]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-board-list-desktop.png`, fullPage: true });
    // restored primary CTA, enabled (accent): open create row (+ 新建) and fill it so "+ task" lights up
    await page.locator('[aria-label="new issue"]').click();
    await page.waitForSelector('[data-bnw-board-create]', { timeout: 8000 });
    await page.locator('[aria-label="new task"]').fill("draft the device-auth enrollment page");
    await sleep(80); await page.screenshot({ path: `${SHOTS}/bnw-board-list-cta-enabled-desktop.png`, fullPage: true });
    await page.locator('[aria-label="new issue"]').click(); // close create row
    await page.locator('[aria-label="manage labels"]').click();
    await page.waitForSelector('[data-bnw-board-labels]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-board-labels-desktop.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/mesh/demo/board?view=kanban`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-kanban]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-board-kanban-desktop.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/mesh/demo/board/issue/12`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-detail]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-board-detail-desktop.png`, fullPage: true });
    // restored primary CTA, enabled (accent): type a comment so "评论" lights up
    await page.locator('[aria-label="comment input"]').fill("looks good — merging once CI is green");
    await sleep(80); await page.screenshot({ path: `${SHOTS}/bnw-board-detail-cta-enabled-desktop.png`, fullPage: true });
    // 7.3 new-mesh (desktop) + expanded editor + assistant (desktop) + assistant fullscreen
    await page.goto(`${BASE}/bnw/mesh/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-newmesh]', { timeout: 8000 });
    await page.locator('[aria-label="mesh name"]').fill("app");
    await page.locator('[aria-label="agent 1 id"]').fill("router");
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-newmesh-desktop.png`, fullPage: true });
    // restored primary CTA, enabled (accent): a valid project makes Save/Create accent
    await page.locator('[aria-label="agent 1 project"]').fill("/repo/app");
    await sleep(80); await page.screenshot({ path: `${SHOTS}/bnw-newmesh-cta-enabled-desktop.png`, fullPage: true });
    await page.locator('[aria-label="expand charter"]').click();
    await page.waitForSelector('[data-bnw-editor]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-newmesh-editor-desktop.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/assistant`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-assistant="panel"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-assistant-desktop.png`, fullPage: true });
    // restored primary CTA, enabled (accent): typing a message makes Send accent
    await page.locator('[aria-label="assistant input"]').fill("build a router(claude) + codex member app mesh");
    await sleep(80); await page.screenshot({ path: `${SHOTS}/bnw-assistant-cta-enabled-desktop.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/assistant?full=1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-assistant="full"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-assistant-fullscreen-desktop.png`, fullPage: true });
    // 7.5-C global states — 404 + error card (desktop). Error card via SPA nav so the test
    // flag survives (a full goto resets window).
    await page.goto(`${BASE}/bnw/no-such-surface`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-not-found]', { timeout: 8000 });
    await sleep(100); await page.screenshot({ path: `${SHOTS}/bnw-404-desktop.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await page.evaluate(() => { (window as any).__bnwForceError = true; history.pushState({}, "", "/bnw/doctor"); dispatchEvent(new PopStateEvent("popstate")); });
    await page.waitForSelector('[data-bnw-error-boundary]', { timeout: 8000 });
    await sleep(100); await page.screenshot({ path: `${SHOTS}/bnw-error-desktop.png`, fullPage: true });
    await page.evaluate(() => { (window as any).__bnwForceError = false; });
    // mobile overview + mobile board list + mobile new-mesh + mobile assistant
    await page.setViewportSize({ width: 390, height: 844 });
    // 7.5-C global states — error card + 404 (mobile)
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await page.evaluate(() => { (window as any).__bnwForceError = true; history.pushState({}, "", "/bnw/doctor"); dispatchEvent(new PopStateEvent("popstate")); });
    await page.waitForSelector('[data-bnw-error-boundary]', { timeout: 8000 });
    await sleep(100); await page.screenshot({ path: `${SHOTS}/bnw-error-mobile.png`, fullPage: true });
    await page.evaluate(() => { (window as any).__bnwForceError = false; });
    await page.goto(`${BASE}/bnw/no-such-surface`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-not-found]', { timeout: 8000 });
    await sleep(100); await page.screenshot({ path: `${SHOTS}/bnw-404-mobile.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-runtime-overview-mobile.png`, fullPage: true });
    // 7.5-B — runtime focus mobile (transcript + C2 docked approval bar)
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-focus="split"]', { timeout: 8000 });
    await page.evaluate((s) => (window as any).__meshStore.apply({ t: "snapshot", state: s }), SEED_FOCUS);
    await page.waitForSelector('[data-bnw-approval]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-runtime-focus-mobile.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/mesh/demo/board`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-list]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-board-list-mobile.png`, fullPage: true });
    // 7.5-B — board detail mobile (lifecycle path + activity timeline + comment)
    await page.goto(`${BASE}/bnw/mesh/demo/board/issue/12`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-board-detail]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-board-detail-mobile.png`, fullPage: true });
    // 7.5-A — mobile 更多 management overlay
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-bottomtabs]', { timeout: 8000 });
    await page.locator('[data-bnw-more-toggle]').click();
    await page.waitForSelector('[data-bnw-more]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-shell-more-mobile.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/mesh/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-newmesh]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-newmesh-mobile.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/assistant`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-assistant="panel"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-assistant-mobile.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/doctor`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-doctor-summary]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-doctor-mobile.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/harnesses`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-harness-row]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-harnesses-mobile.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/channels`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-channel-status]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-channels-mobile.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router/file/report.md`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-artifact-kind="markdown"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-file-viewer-mobile.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-theme-matrix]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-settings-mobile.png`, fullPage: true });
    await page.goto(`${BASE}/bnw/notifications`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-notifications="center"]', { timeout: 8000 });
    await sleep(120); await page.screenshot({ path: `${SHOTS}/bnw-notifications-mobile.png`, fullPage: true });
  });

  if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log(`BNW E2E: ${passed} passed, 0 failed`);
  console.log("BNW E2E OK");
} finally {
  await browser.close();
  handle.stop();
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
