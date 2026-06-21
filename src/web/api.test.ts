import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "./api";
import { DEFAULT_BACKFILL_LIMIT, MAX_SNAPSHOT_TRANSCRIPT_ITEMS, WebGateway } from "./gateway";
import { artifactAgentDir } from "./artifacts";
import type { MeshEvent, MeshConfig } from "../acp/types";
import { HarnessInstallError, resetHarnessInstallJobsForTests, startHarnessInstall } from "../harness-install";

const CFG: MeshConfig = {
  name: "demo",
  agents: [
    { id: "router", harness: "claude", project: "p", role: "router" },
    { id: "codex-1", harness: "codex", project: "p", role: "member" },
  ],
  edges: [{ from: "router", to: "codex-1" }],
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SAME_ORIGIN = "http://localhost:7317";
const sameOriginCtx = () => ({ headers: new Headers({ origin: SAME_ORIGIN }), expectedOrigin: SAME_ORIGIN });

function fakeManager(config: MeshConfig = CFG) {
  const calls: any[] = [];
  let listener: ((n: string, e: MeshEvent) => void) | null = null;
  return {
    calls,
    emit(n: string, e: MeshEvent) {
      listener?.(n, e);
    },
    on(l: (n: string, e: MeshEvent) => void) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    listMeshes() {
      return [{ name: "demo", defined: true, status: "running" as const }];
    },
    configOf(n = config.name) {
      if (n !== config.name) throw new Error(`no such mesh "${n}"`);
      return config;
    },
    routerOf() {
      return config.agents.find((a) => a.role === "router")?.id ?? "router";
    },
    async startMesh(n: string, opts?: any) {
      calls.push(["start", n, opts]);
    },
    async stopMesh(n: string) {
      calls.push(["stop", n]);
    },
    async promptRouter(n: string, t: string, images?: any[]) {
      calls.push(["promptRouter", n, t, images]);
    },
    promptAgent(n: string, a: string, t: string, images?: any[]) {
      calls.push(["promptAgent", n, a, t, images]);
    },
    removeQueuedTurn(n: string, a: string, turnId: string) {
      calls.push(["removeQueuedTurn", n, a, turnId]);
    },
    steerAgent(n: string, a: string, t: string, images?: any[]) {
      calls.push(["steerAgent", n, a, t, images]);
    },
    wakeAgent(n: string, a: string) {
      calls.push(["wakeAgent", n, a]);
    },
    stopAgent(n: string, a: string) {
      calls.push(["stopAgent", n, a]);
    },
    async addEdge(n: string, edge: any) {
      calls.push(["addEdge", n, edge]);
    },
    async addAgent(n: string, agent: any, edges: any[] = []) {
      calls.push(["addAgent", n, agent, edges]);
    },
    resolvePermission(n: string, r: string, o: string) {
      calls.push(["resolve", n, r, o]);
    },
    async setMode(n: string, a: string, m: string) {
      calls.push(["setMode", n, a, m]);
    },
    async setModel(n: string, a: string, m: string) {
      calls.push(["setModel", n, a, m]);
    },
    interruptAgent(n: string, a: string) {
      calls.push(["interrupt", n, a]);
    },
    async newAgentSession(n: string, a: string) {
      calls.push(["newAgentSession", n, a]);
    },
    async respawnAgent(n: string, a: string, mode: string) {
      calls.push(["respawnAgent", n, a, mode]);
      if (mode === "after-idle") return { mode, scheduled: true, willRunWhen: "idle", note: "ACP session context will be lost; mailbox preserved" };
      if (mode === "cancel") return { mode, scheduled: false };
      return { mode, scheduled: false, willRunWhen: "now", note: "ACP session context will be lost; mailbox preserved" };
    },
    async newAllSessions(n: string) {
      calls.push(["newAllSessions", n]);
    },
    async readBoard(n: string) {
      calls.push(["readBoard", n]);
      return { mesh: n, revision: 3, epicSeq: 0, taskSeq: 1, epics: [], tasks: [{ id: 1, title: "t", status: "todo", priority: "normal", deps: [], subtasks: [], subtaskSeq: 0, revision: 1, createdBy: "x", createdAt: "T", updatedAt: "T", comments: [], mailEventIds: [] }] };
    },
    async boardCommand(n: string, actor: any, command: any, ebr: number) {
      calls.push(["boardCommand", n, actor, command, ebr]);
      return { ok: true, state: { mesh: n, revision: ebr + 1, epicSeq: 0, taskSeq: 1, epics: [], tasks: [] }, change: { entity: "task", taskId: 1 } };
    },
    async defineMesh(c: MeshConfig) {
      calls.push(["define", c.name]);
    },
    async deleteMesh(n: string) {
      calls.push(["delete", n]);
    },
    async loadDefinitions() {
      calls.push(["reload"]);
    },
    async stopAll() {},
  };
}

test("GET /api/state returns the snapshot", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(gw, "GET", "/api/state", undefined);
  expect(r.status).toBe(200);
  expect(r.body.meshes[0].name).toBe("demo");
});

test("GET /api/harnesses probes harness installation on each request", async () => {
  let calls = 0;
  const harnessProbe = () => {
    calls += 1;
    return [{ id: "codex", installed: calls === 2 }];
  };
  const gw = new WebGateway(fakeManager() as any);
  const first = await handleApi(gw, "GET", "/api/harnesses", undefined, new URLSearchParams(), harnessProbe as any);
  const second = await handleApi(gw, "GET", "/api/harnesses", undefined, new URLSearchParams(), harnessProbe as any);
  expect(first).toEqual({ status: 200, body: [{ id: "codex", installed: false }] });
  expect(second).toEqual({ status: 200, body: [{ id: "codex", installed: true }] });
});

test("GET /api/harnesses awaits async harness probes", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(gw, "GET", "/api/harnesses", undefined, new URLSearchParams(), async () => [{ id: "codex", installed: true }] as any);
  expect(r).toEqual({ status: 200, body: [{ id: "codex", installed: true }] });
});

test("GET /api/harnesses includes running agents using older resolved versions", async () => {
  const manager = {
    ...fakeManager(),
    listResolvedHarnesses() {
      return [
        { mesh: "demo", agentId: "router", harnessId: "codex", version: "0.15.0", path: "/bin/codex-acp", spawnedAt: "t" },
        { mesh: "demo", agentId: "codex-1", harnessId: "codex", version: "0.16.0", path: "/bin/codex-acp", spawnedAt: "t" },
      ];
    },
  };
  const gw = new WebGateway(manager as any);
  const r = await handleApi(
    gw,
    "GET",
    "/api/harnesses",
    undefined,
    new URLSearchParams(),
    async (opts: any) => [{
      id: "codex",
      installed: true,
      runningAgentsUsingOldVersion: opts.runningAgentsUsingOldVersion("codex", "0.16.0"),
    }] as any,
  );
  expect(r.body[0].runningAgentsUsingOldVersion).toEqual(["demo/router"]);
});

test("GET /api/harnesses/:id/models returns probed model list and passes refresh", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const calls: any[] = [];
  const r = await handleApi(
    gw,
    "GET",
    "/api/harnesses/codex/models",
    undefined,
    new URLSearchParams("refresh=1"),
    undefined,
    async (id, opts) => {
      calls.push([id, opts]);
      return { models: [{ id: "gpt-5.5", name: "GPT 5.5" }], probedAt: 1234 };
    },
  );
  expect(r).toEqual({ status: 200, body: { models: [{ id: "gpt-5.5", name: "GPT 5.5" }], probedAt: 1234 } });
  expect(calls).toEqual([["codex", { refresh: true }]]);
});

test("GET /api/harnesses/:id/models returns 4xx for uninstalled harnesses", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(
    gw,
    "GET",
    "/api/harnesses/kimi/models",
    undefined,
    new URLSearchParams(),
    undefined,
    async () => {
      throw new Error("harness kimi is not installed");
    },
  );
  expect(r.status).toBe(409);
  expect(r.body.error.message).toContain("harness kimi is not installed");
});

test("GET /api/harnesses/:id/models rejects prototype property names as unknown harnesses", async () => {
  const gw = new WebGateway(fakeManager() as any);
  let called = false;
  const r = await handleApi(
    gw,
    "GET",
    "/api/harnesses/constructor/models",
    undefined,
    new URLSearchParams(),
    undefined,
    async () => {
      called = true;
      return { models: [], probedAt: 0 };
    },
  );
  expect(r.status).toBe(404);
  expect(r.body.error.message).toContain("unknown harness");
  expect(called).toBe(false);
});

test("GET /api/channels/feishu/status returns the feishu controller status", async () => {
  const feishu = {
    status: () => ({ state: "disabled", configPath: "/tmp/channels/feishu.json", configured: false, enabled: false, updatedAt: "T" }),
    reload: async () => ({}),
    startProvision: async () => ({}),
    getProvision: () => undefined,
    cancelProvision: () => undefined,
  };
  const gw = new WebGateway(fakeManager() as any, undefined, { channels: { feishu: feishu as any } });
  const r = await handleApi(gw, "GET", "/api/channels/feishu/status", undefined);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ state: "disabled", enabled: false });
});

test("POST /api/channels/feishu/reload is same-origin protected and delegates to controller", async () => {
  let calls = 0;
  const feishu = {
    status: () => ({}),
    reload: async () => {
      calls++;
      return { state: "running", configPath: "/tmp/c", configured: true, enabled: true, updatedAt: "T" };
    },
    startProvision: async () => ({}),
    getProvision: () => undefined,
    cancelProvision: () => undefined,
  };
  const gw = new WebGateway(fakeManager() as any, undefined, { channels: { feishu: feishu as any } });
  const denied = await handleApi(gw, "POST", "/api/channels/feishu/reload", {});
  expect(denied.status).toBe(403);
  const ok = await handleApi(gw, "POST", "/api/channels/feishu/reload", {}, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  expect(ok.status).toBe(200);
  expect(ok.body.state).toBe("running");
  expect(calls).toBe(1);
});

test("POST/GET/CANCEL /api/channels/feishu/provision delegates to controller", async () => {
  const jobs = new Map<string, any>();
  const feishu = {
    status: () => ({}),
    reload: async () => ({}),
    startProvision: async (input: any) => {
      const job = { id: "job-1", state: "waiting", createdAt: "T", updatedAt: "T", verificationUrl: "https://open.feishu.cn/x", qrCodeDataUrl: "data:image/png", input };
      jobs.set(job.id, job);
      return job;
    },
    getProvision: (id: string) => jobs.get(id),
    cancelProvision: (id: string) => {
      const job = jobs.get(id);
      if (job) job.state = "cancelled";
      return job;
    },
  };
  const gw = new WebGateway(fakeManager() as any, undefined, { channels: { feishu: feishu as any } });
  const started = await handleApi(gw, "POST", "/api/channels/feishu/provision", { mesh: "m" }, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  expect(started.status).toBe(200);
  expect(started.body).toMatchObject({ id: "job-1", verificationUrl: "https://open.feishu.cn/x" });

  const fetched = await handleApi(gw, "GET", "/api/channels/feishu/provision/job-1", undefined);
  expect(fetched.body.state).toBe("waiting");

  const cancelled = await handleApi(gw, "POST", "/api/channels/feishu/provision/job-1/cancel", {}, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  expect(cancelled.body.state).toBe("cancelled");
});

test("POST /api/channels/feishu/sync and mesh group endpoints delegate with same-origin protection", async () => {
  const calls: any[] = [];
  const feishu = {
    status: () => ({}),
    reload: async () => ({}),
    startProvision: async () => ({}),
    getProvision: () => undefined,
    cancelProvision: () => undefined,
    syncMeshChats: async () => {
      calls.push(["sync"]);
      return [{ mesh: "demo", ok: true, chatId: "oc_1" }];
    },
    ensureMeshChat: async (mesh: string) => {
      calls.push(["ensure", mesh]);
      return { mesh, ok: true, chatId: `oc_${mesh}` };
    },
  };
  const gw = new WebGateway(fakeManager() as any, undefined, { channels: { feishu: feishu as any } });
  expect((await handleApi(gw, "POST", "/api/channels/feishu/sync", {})).status).toBe(403);
  const synced = await handleApi(gw, "POST", "/api/channels/feishu/sync", {}, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  const ensured = await handleApi(gw, "POST", "/api/channels/feishu/meshes/demo/group", {}, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  expect(synced.body).toEqual([{ mesh: "demo", ok: true, chatId: "oc_1" }]);
  expect(ensured.body).toEqual({ mesh: "demo", ok: true, chatId: "oc_demo" });
  expect(calls).toEqual([["sync"], ["ensure", "demo"]]);
});

test("POST /api/meshes auto-creates a Feishu group when a bot is bound", async () => {
  const m = fakeManager();
  const calls: string[] = [];
  const feishu = {
    status: () => ({}),
    reload: async () => ({}),
    startProvision: async () => ({}),
    getProvision: () => undefined,
    cancelProvision: () => undefined,
    syncMeshChats: async () => [],
    ensureMeshChat: async (mesh: string) => {
      calls.push(mesh);
      return { mesh, ok: true, chatId: `oc_${mesh}` };
    },
  };
  const gw = new WebGateway(m as any, undefined, { channels: { feishu: feishu as any } });
  const r = await handleApi(gw, "POST", "/api/meshes", {
    name: "new",
    agents: [{ id: "r", harness: "claude", project: "p", role: "router" }],
    edges: [],
  });
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["define", "new"]);
  expect(calls).toEqual(["new"]);
  expect(r.body.feishu).toMatchObject({ mesh: "new", ok: true, chatId: "oc_new" });
});

test("POST /api/harnesses/claude/install starts an install job", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(
    gw,
    "POST",
    "/api/harnesses/claude/install",
    {},
    new URLSearchParams(),
    undefined,
    undefined,
    async (id) => ({ id: "job-1", harnessId: id, pkgSpec: "@agentclientprotocol/claude-agent-acp@0.44.0", status: "running" }) as any,
    sameOriginCtx(),
  );
  expect(r).toEqual({ status: 200, body: { jobId: "job-1", status: "running", harnessId: "claude", pkgSpec: "@agentclientprotocol/claude-agent-acp@0.44.0" } });
});

test("POST /api/harnesses/:id/install rejects non-npm and unknown harnesses", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const opencode = await handleApi(gw, "POST", "/api/harnesses/opencode/install", {}, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  const unknown = await handleApi(gw, "POST", "/api/harnesses/unknown/install", {}, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  expect(opencode.status).toBe(400);
  expect(opencode.body.error.message).toContain("not npm-installable");
  expect(unknown.status).toBe(400);
  expect(unknown.body.error.message).toContain("unknown harness");
});

test("POST /api/harnesses/:id/install returns 409 when npm is missing", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(
    gw,
    "POST",
    "/api/harnesses/claude/install",
    {},
    new URLSearchParams(),
    undefined,
    undefined,
    async () => {
      throw new HarnessInstallError("missing-npm", "Install Node.js first");
    },
    sameOriginCtx(),
  );
  expect(r).toEqual({ status: 409, body: { error: "missing-npm", hint: "Install Node.js first" } });
});

test("POST /api/harnesses/:id/install returns the active job for duplicate starts", async () => {
  resetHarnessInstallJobsForTests();
  let resolveExit!: (code: number) => void;
  const gw = new WebGateway(fakeManager() as any);
  const install = (id: any) => startHarnessInstall(id, {
    prefix: "/tmp/mesh-home/.agent-mesh/npm-global",
    home: "/tmp/mesh-home",
    which: () => "/usr/bin/npm",
    spawn: () => ({ exited: new Promise<number>((resolve) => { resolveExit = resolve; }), stdout: new Response("").body, stderr: new Response("").body }),
  });
  const first = await handleApi(gw, "POST", "/api/harnesses/codex/install", {}, new URLSearchParams(), undefined, undefined, install, sameOriginCtx());
  const second = await handleApi(gw, "POST", "/api/harnesses/codex/install", {}, new URLSearchParams(), undefined, undefined, install, sameOriginCtx());
  expect(second.body.jobId).toBe(first.body.jobId);
  resolveExit(0);
});

test("GET /api/harnesses/:id/install/:jobId/stream returns redacted NDJSON without argv or env", async () => {
  resetHarnessInstallJobsForTests();
  const gw = new WebGateway(fakeManager() as any);
  const install = (id: any) => startHarnessInstall(id, {
    prefix: "/tmp/mesh-home/.agent-mesh/npm-global",
    home: "/tmp/mesh-home",
    which: () => "/usr/bin/npm",
    spawn: () => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("using /home/chenan/x.log\n")); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("npm_config_ignore_scripts --prefix --registry\n")); c.close(); } }),
    }),
    reprobe: async () => [{ id, installed: true, version: "1.2.3", path: "/home/chenan/.agent-mesh/npm-global/bin/codex-acp" }] as any,
  });
  const started = await handleApi(gw, "POST", "/api/harnesses/codex/install", {}, new URLSearchParams(), undefined, undefined, install, sameOriginCtx());
  const streamed = await handleApi(gw, "GET", `/api/harnesses/codex/install/${started.body.jobId}/stream`, undefined, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  expect(streamed.status).toBe(200);
  expect(streamed.body).toBeInstanceOf(Response);
  const text = await (streamed.body as Response).text();
  expect(text).toContain("~/x.log");
  expect(text).not.toContain("/home/chenan");
  expect(text).not.toContain("--prefix");
  expect(text).not.toContain("--registry");
  expect(text).not.toContain("npm_config_ignore_scripts");
});

test("harness install endpoints require same-origin request headers", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const installer = async (id: any) => ({ id: "job-1", harnessId: id, pkgSpec: "@agentclientprotocol/claude-agent-acp@0.44.0", status: "running" }) as any;
  const missing = await handleApi(gw, "POST", "/api/harnesses/claude/install", {}, new URLSearchParams(), undefined, undefined, installer);
  const cross = await handleApi(
    gw,
    "POST",
    "/api/harnesses/claude/install",
    {},
    new URLSearchParams(),
    undefined,
    undefined,
    installer,
    { headers: new Headers({ origin: "http://evil.test" }), expectedOrigin: SAME_ORIGIN },
  );
  const ok = await handleApi(gw, "POST", "/api/harnesses/claude/install", {}, new URLSearchParams(), undefined, undefined, installer, sameOriginCtx());
  expect(missing.status).toBe(403);
  expect(cross.status).toBe(403);
  expect(ok.status).toBe(200);
});

test("POST /api/harnesses/:id/reprobe requires same-origin request headers", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const probe = async () => [{ id: "opencode", installed: true }] as any;
  const missing = await handleApi(gw, "POST", "/api/harnesses/opencode/reprobe", {}, new URLSearchParams(), probe);
  const cross = await handleApi(
    gw,
    "POST",
    "/api/harnesses/opencode/reprobe",
    {},
    new URLSearchParams(),
    probe,
    undefined,
    undefined,
    { headers: new Headers({ origin: "http://evil.test" }), expectedOrigin: SAME_ORIGIN },
  );
  const ok = await handleApi(gw, "POST", "/api/harnesses/opencode/reprobe", {}, new URLSearchParams(), probe, undefined, undefined, sameOriginCtx());
  expect(missing.status).toBe(403);
  expect(cross.status).toBe(403);
  expect(ok.status).toBe(200);
});

test("POST /api/harnesses/:id/reprobe clears caches, refreshes probe, and broadcasts", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const messages: any[] = [];
  gw.subscribe((m) => messages.push(m));
  const calls: any[] = [];
  const r = await handleApi(
    gw,
    "POST",
    "/api/harnesses/kimi/reprobe",
    {},
    new URLSearchParams(),
    async (opts) => {
      calls.push(["probe", opts]);
      return [{ id: "kimi", installed: true, version: "0.1.0" }] as any;
    },
    undefined,
    undefined,
    {
      ...sameOriginCtx(),
      clearProbeCache: (id) => calls.push(["clearProbe", id]),
      clearModelsCache: (id) => calls.push(["clearModels", id]),
    },
  );
  expect(r).toEqual({ status: 200, body: { id: "kimi", installed: true, version: "0.1.0" } });
  expect(calls).toEqual([["clearProbe", "kimi"], ["clearModels", "kimi"], ["probe", { refresh: true }]]);
  expect(messages).toContainEqual({ t: "harnesses-changed", harnessId: "kimi" });
});

test("POST /api/meshes/demo/start delegates to startMesh", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/start", {});
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["start", "demo", undefined]);
});

test("POST /api/meshes/demo/start can request a fresh session strategy", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/start", { sessionStrategy: "fresh" });
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["start", "demo", { sessionStrategy: "fresh" }]);
});

test("POST /api/meshes/demo/prompt delegates to promptRouter", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/prompt", { text: "go" });
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["promptRouter", "demo", "go", []]);
});

test("POST /api/meshes/demo/agents/codex-1/prompt delegates to promptAgent", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/prompt", { text: "hey" });
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["promptAgent", "demo", "codex-1", "hey", []]);
});

test("POST /api/meshes/demo/agents/codex-1/steer delegates to steerAgent", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/steer", { text: "urgent" });
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["steerAgent", "demo", "codex-1", "urgent", []]);
});

test("GET /api/meshes/:mesh/agents/:agent/transcript backfills older transcript items", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  for (let i = 0; i < 1000; i++) {
    m.emit("demo", { kind: "compact_started", agent: "codex-1", reason: `r${i}`, ts: 1000 + i } as any);
  }

  const snap = gw.snapshot().perMesh.demo.transcripts["codex-1"];
  expect(snap.items).toHaveLength(MAX_SNAPSHOT_TRANSCRIPT_ITEMS);
  expect(snap.hasMore).toBe(true);
  expect(snap.oldestSeq).toBeUndefined();

  const tail = await handleApi(
    gw,
    "GET",
    "/api/meshes/demo/agents/codex-1/transcript",
    undefined,
  );
  expect(tail.status).toBe(200);
  expect(tail.body.items).toHaveLength(DEFAULT_BACKFILL_LIMIT);
  expect(tail.body.items[0]).toMatchObject({ reason: "r900" });
  expect(tail.body.items.at(-1)).toMatchObject({ reason: "r999" });
  expect(tail.body.hasMore).toBe(true);

  const first = await handleApi(
    gw,
    "GET",
    "/api/meshes/demo/agents/codex-1/transcript",
    undefined,
    new URLSearchParams({ before: tail.body.items[0].id, limit: "100" }),
  );
  expect(first.status).toBe(200);
  expect(first.body.items).toHaveLength(100);
  expect(first.body.items[0]).toMatchObject({ reason: "r800" });
  expect(first.body.items.at(-1)).toMatchObject({ reason: "r899" });
  expect(first.body.hasMore).toBe(true);

  const second = await handleApi(
    gw,
    "GET",
    "/api/meshes/demo/agents/codex-1/transcript",
    undefined,
    new URLSearchParams({ before: first.body.items[0].id, limit: "100" }),
  );
  expect(second.status).toBe(200);
  expect(second.body.items).toHaveLength(100);
  expect(second.body.items[0]).toMatchObject({ reason: "r700" });
  expect(second.body.items.at(-1)).toMatchObject({ reason: "r799" });
  expect(second.body.hasMore).toBe(true);
});

test("GET transcript backfill validates limits and unknown mesh or agent", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const tooLarge = await handleApi(gw, "GET", "/api/meshes/demo/agents/codex-1/transcript", undefined, new URLSearchParams({ limit: "1000" }));
  expect(tooLarge.status).toBe(400);
  const missingMesh = await handleApi(gw, "GET", "/api/meshes/missing/agents/codex-1/transcript", undefined);
  expect(missingMesh.status).toBe(404);
  const missingAgent = await handleApi(gw, "GET", "/api/meshes/demo/agents/nope/transcript", undefined);
  expect(missingAgent.status).toBe(404);
});

test("GET /api/meshes/:mesh/agents/:agent/artifacts/:path serves scoped artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "api-artifacts-"));
  try {
    const dir = artifactAgentDir(root, "demo", "codex-1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "report.md"), "# artifact\n");
    const gw = new WebGateway(fakeManager() as any, undefined, { root });
    const r = await handleApi(gw, "GET", "/api/meshes/demo/agents/codex-1/artifacts/report.md", undefined);
    expect(r.status).toBe(200);
    expect(r.body).toBeInstanceOf(Response);
    expect(await r.body.text()).toBe("# artifact\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GET artifact route rejects unknown mesh/agent pairs", async () => {
  const root = await mkdtemp(join(tmpdir(), "api-artifacts-missing-"));
  try {
    const gw = new WebGateway(fakeManager() as any, undefined, { root });
    const missingMesh = await handleApi(gw, "GET", "/api/meshes/missing/agents/codex-1/artifacts/report.md", undefined);
    expect(missingMesh.status).toBe(404);
    const missingAgent = await handleApi(gw, "GET", "/api/meshes/demo/agents/nope/artifacts/report.md", undefined);
    expect(missingAgent.status).toBe(404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DELETE /api/meshes/demo/agents/codex-1/queue/q1 delegates to removeQueuedTurn", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any) as any;
  gw.removeQueuedTurn = (n: string, a: string, turnId: string) => m.calls.push(["removeQueuedTurn", n, a, turnId]);
  const r = await handleApi(gw, "DELETE", "/api/meshes/demo/agents/codex-1/queue/q1", {});
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["removeQueuedTurn", "demo", "codex-1", "q1"]);
});

test("POST /api/meshes/demo/agents/codex-1/wake delegates to wakeAgent", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/wake", {});
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["wakeAgent", "demo", "codex-1"]);
});

test("POST /api/meshes/demo/agents/codex-1/stop delegates to stopAgent", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/stop", {});
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["stopAgent", "demo", "codex-1"]);
});

test("POST /api/meshes/demo/edges delegates to addEdge", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/edges", { from: "codex-1", to: "router", steer: true });
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["addEdge", "demo", { from: "codex-1", to: "router", steer: true }]);
});

test("POST /api/meshes/demo/agents delegates to addAgent", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/agents", {
    agent: { id: "newbie", harness: "codex", project: "p" },
    edges: [{ from: "router", to: "newbie" }],
  });
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual([
    "addAgent",
    "demo",
    { id: "newbie", harness: "codex", project: "p", role: "member", lazy: undefined, effort: undefined, opencodePermission: undefined, mode: undefined, model: undefined, instructions: undefined },
    [{ from: "router", to: "newbie", steer: false }],
  ]);
});

test("POST /api/meshes/demo/agents/codex-1/mode delegates to setMode", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/mode", { modeId: "read-only" });
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["setMode", "demo", "codex-1", "read-only"]);
});

test("POST /api/meshes/demo/agents/codex-1/model delegates to setModel", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/model", { modelId: "deepseek-v3" });
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["setModel", "demo", "codex-1", "deepseek-v3"]);
});

test("POST /api/meshes/demo/agents/codex-1/interrupt delegates to interruptAgent", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/interrupt", {});
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["interrupt", "demo", "codex-1"]);
});

test("POST /api/meshes/demo/agents/codex-1/session delegates to newAgentSession", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/session", {});
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["newAgentSession", "demo", "codex-1"]);
});

test("POST /api/meshes/:mesh/agents/:agent/respawn requires same-origin headers", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const missing = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/respawn", { mode: "force" });
  const cross = await handleApi(
    gw,
    "POST",
    "/api/meshes/demo/agents/codex-1/respawn",
    { mode: "force" },
    new URLSearchParams(),
    undefined,
    undefined,
    undefined,
    { headers: new Headers({ origin: "http://evil.test" }), expectedOrigin: SAME_ORIGIN },
  );
  const ok = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/respawn", { mode: "force" }, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  expect(missing.status).toBe(403);
  expect(cross.status).toBe(403);
  expect(ok.status).toBe(200);
});

test("POST /api/meshes/:mesh/agents/:agent/respawn delegates after-idle, force, and cancel", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const afterIdle = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/respawn", { mode: "after-idle" }, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  const force = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/respawn", { mode: "force" }, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  const cancel = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/respawn", { mode: "cancel" }, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  const bad = await handleApi(gw, "POST", "/api/meshes/demo/agents/codex-1/respawn", { mode: "restart" }, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  expect(afterIdle.body).toMatchObject({ mode: "after-idle", scheduled: true, willRunWhen: "idle" });
  expect(force.body).toMatchObject({ mode: "force", scheduled: false, willRunWhen: "now", note: "ACP session context will be lost; mailbox preserved" });
  expect(cancel.body).toMatchObject({ mode: "cancel", scheduled: false });
  expect(bad.status).toBe(400);
  expect(m.calls).toContainEqual(["respawnAgent", "demo", "codex-1", "after-idle"]);
  expect(m.calls).toContainEqual(["respawnAgent", "demo", "codex-1", "force"]);
  expect(m.calls).toContainEqual(["respawnAgent", "demo", "codex-1", "cancel"]);
});

test("POST /api/meshes/demo/session delegates to newAllSessions", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/session", {});
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["newAllSessions", "demo"]);
});

test("POST /api/meshes/demo/permissions/r1/resolve delegates to resolvePermission", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/permissions/r1/resolve", { optionId: "allow" });
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["resolve", "demo", "r1", "allow"]);
});

test("POST /api/meshes/reload delegates to loadDefinitions", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/reload", {});
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["reload"]);
});

test("POST /api/meshes with a valid config defines it", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes", {
    name: "new",
    agents: [{ id: "r", harness: "claude", project: "p", role: "router" }],
    edges: [],
  });
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["define", "new"]);
});

test("POST /api/meshes with an invalid config returns 400", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes", { name: "bad", agents: [], edges: [] });
  expect(r.status).toBe(400);
  expect(r.body.error.message).toBeTruthy();
  expect(m.calls.some((c) => c[0] === "define")).toBe(false);
});

test("DELETE /api/meshes/demo delegates to deleteMesh", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "DELETE", "/api/meshes/demo", undefined);
  expect(r.status).toBe(200);
  expect(m.calls).toContainEqual(["delete", "demo"]);
});

test("unknown route returns 404", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(gw, "GET", "/api/nope", undefined);
  expect(r.status).toBe(404);
});

test("POST /api/assistant/prompt returns 409 when assistant absent", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(gw, "POST", "/api/assistant/prompt", { text: "hi" });
  expect(r.status).toBe(409);
});

test("POST /api/master/prompt remains a legacy alias for assistant prompt", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(gw, "POST", "/api/master/prompt", { text: "hi" });
  expect(r.status).toBe(409);
});

test("POST /api/master/interrupt remains a legacy alias for assistant interrupt", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(gw, "POST", "/api/master/interrupt", {});
  expect(r.status).toBe(200);
});

test("POST and GET /api/uploads store and serve safe image files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-api-upload-"));
  try {
    const gw = new WebGateway(fakeManager() as any, undefined, { root });
    const post = await handleApi(
      gw,
      "POST",
      "/api/uploads",
      { files: [new File([PNG], "shot.png", { type: "image/png" })] },
      new URLSearchParams("bucket=demo"),
    );
    expect(post.status).toBe(200);
    expect(post.body[0]).toMatchObject({ mimeType: "image/png", name: "shot.png" });
    expect(post.body[0].path).toBeUndefined();
    expect(post.body[0].bucket).toBeUndefined();
    const get = await handleApi(gw, "GET", `/api/uploads/demo/${post.body[0].id}`, undefined);
    expect(get.body).toBeInstanceOf(Response);
    const resp = get.body as Response;
    expect(resp.headers.get("content-type")).toBe("image/png");
    expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(resp.headers.get("content-disposition")).toContain("inline");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("POST /api/uploads rejects unknown buckets and bad content", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-api-upload-"));
  try {
    const gw = new WebGateway(fakeManager() as any, undefined, { root });
    const unknown = await handleApi(gw, "POST", "/api/uploads", { files: [new File([PNG], "shot.png", { type: "image/png" })] }, new URLSearchParams("bucket=../bad"));
    expect(unknown.status).toBe(400);
    const bad = await handleApi(gw, "POST", "/api/uploads", { files: [new File(["<svg></svg>"], "bad.png", { type: "image/png" })] }, new URLSearchParams("bucket=demo"));
    expect(bad.status).toBe(400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /api/agents/:name/files serves agent files with security headers and mapped errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-api-agent-files-"));
  try {
    await writeFile(join(root, "report.md"), "# Report\n");
    await writeFile(join(root, "secret.exe"), "exists");
    await writeFile(join(root, "bad.png"), "not a png");
    await writeFile(join(root, "big.log"), new Uint8Array(5 * 1024 * 1024 + 1));
    await symlink(join(root, "report.md"), join(root, "link.md"));
    const cfg: MeshConfig = {
      name: "demo",
      agents: [
        { id: "router", harness: "claude", project: root, role: "router" },
        { id: "codex-1", harness: "codex", project: root, role: "member" },
      ],
      edges: [{ from: "router", to: "codex-1" }],
    };
    const gw = new WebGateway(fakeManager(cfg) as any);

    const ok = await handleApi(gw, "GET", "/api/agents/codex-1/files/report.md", undefined);
    expect(ok.status).toBe(200);
    const resp = ok.body as Response;
    expect(resp).toBeInstanceOf(Response);
    expect(resp.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(resp.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(resp.headers.get("cache-control")).toBe("private, max-age=60");
    expect(await resp.text()).toBe("# Report\n");

    expect((await handleApi(gw, "GET", "/api/agents/ghost/files/report.md", undefined)).status).toBe(404);
    expect((await handleApi(gw, "GET", "/api/agents/codex-1/files/missing.md", undefined)).status).toBe(404);
    expect((await handleApi(gw, "GET", "/api/agents/codex-1/files/secret.exe", undefined)).status).toBe(404);
    expect((await handleApi(gw, "GET", "/api/agents/codex-1/files/bad.png", undefined)).status).toBe(404);
    expect((await handleApi(gw, "GET", "/api/agents/codex-1/files/..%2F..%2Fetc%2Fpasswd", undefined)).status).toBe(400);
    expect((await handleApi(gw, "GET", "/api/agents/codex-1/files/link.md", undefined)).status).toBe(400);
    expect((await handleApi(gw, "GET", "/api/agents/codex-1/files/big.log", undefined)).status).toBe(413);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /api/meshes/:name/board returns the board (stopped or running)", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(gw, "GET", "/api/meshes/demo/board", undefined);
  expect(r.status).toBe(200);
  expect(r.body.tasks).toHaveLength(1);
  expect(r.body.tasks[0].title).toBe("t");
});

test("POST /api/meshes/:name/board applies a mutation and returns the new board", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/board", { command: { type: "create_task", title: "x" }, expectedBoardRevision: 0 });
  expect(r.status).toBe(200);
  expect(r.body.board.revision).toBe(1);
  expect(r.body.change).toEqual({ entity: "task", taskId: 1 });
});

test("POST /api/meshes/:name/board maps a CAS conflict to HTTP 409", async () => {
  const m = fakeManager();
  m.boardCommand = (async () => ({ ok: false, code: "conflict", error: "revision conflict" })) as any;
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/board", { command: { type: "set_task_status", id: 1, expectedRevision: 1, status: "done" }, expectedBoardRevision: 9 });
  expect(r.status).toBe(409);
});

test("POST /api/meshes/:name/board maps forbidden to 403 and not_found to 404", async () => {
  const m = fakeManager();
  m.boardCommand = (async () => ({ ok: false, code: "forbidden", error: "router only" })) as any;
  let gw = new WebGateway(m as any);
  expect((await handleApi(gw, "POST", "/api/meshes/demo/board", { command: { type: "create_epic", title: "E" }, expectedBoardRevision: 0 })).status).toBe(403);

  const m2 = fakeManager();
  m2.boardCommand = (async () => ({ ok: false, code: "not_found", error: "no task" })) as any;
  gw = new WebGateway(m2 as any);
  expect((await handleApi(gw, "POST", "/api/meshes/demo/board", { command: { type: "set_task_status", id: 7, expectedRevision: 1, status: "done" }, expectedBoardRevision: 0 })).status).toBe(404);
});

test("POST /api/meshes/:name/board on a stopped mesh is 409 (running-only)", async () => {
  const m = fakeManager();
  m.boardCommand = async () => { throw new Error('mesh "demo" is not running'); };
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/board", { command: { type: "create_task", title: "x" }, expectedBoardRevision: 0 });
  expect(r.status).toBe(409);
});

test("POST /api/meshes/:name/board rejects a missing command with 400", async () => {
  const gw = new WebGateway(fakeManager() as any);
  expect((await handleApi(gw, "POST", "/api/meshes/demo/board", { expectedBoardRevision: 0 })).status).toBe(400);
  expect((await handleApi(gw, "POST", "/api/meshes/demo/board", { command: { type: "create_task", title: "x" } })).status).toBe(400);
});

test("POST /api/meshes/:name/board with an unknown command type maps to 400 (domain invalid)", async () => {
  const m = fakeManager();
  m.boardCommand = (async () => ({ ok: false, code: "invalid", error: 'unknown board command "frobnicate"' })) as any;
  const gw = new WebGateway(m as any);
  const r = await handleApi(gw, "POST", "/api/meshes/demo/board", { command: { type: "frobnicate" }, expectedBoardRevision: 0 });
  expect(r.status).toBe(400);
});

test("GET /api/diagnostics/ps returns the structured ps-detail (empty root → no running/leaks)", async () => {
  const root = await mkdtemp(join(tmpdir(), "api-diag-"));
  try {
    const gw = new WebGateway(fakeManager() as any);
    const r = await handleApi(gw, "GET", "/api/diagnostics/ps", undefined, new URLSearchParams(), undefined, undefined, undefined, { root });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ running: [], leaks: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /api/diagnostics/{ps,doctor} fail with 500 when no auth/diagnostics root is configured", async () => {
  const gw = new WebGateway(fakeManager() as any);
  expect((await handleApi(gw, "GET", "/api/diagnostics/ps", undefined)).status).toBe(500);
  expect((await handleApi(gw, "GET", "/api/diagnostics/doctor", undefined)).status).toBe(500);
});

test("GET /api/diagnostics/ps enriches running agents from the live gateway snapshot (activity)", async () => {
  // A real registry record makes the mesh "running"; webPsSources then reads live agent activity from
  // the gateway snapshot instead of the static config (proving the live-enrichment seam).
  const { writeRecord } = await import("../mesh-registry");
  const root = await mkdtemp(join(tmpdir(), "api-diag-live-"));
  try {
    const runDir = join(root, "run");
    await mkdir(runDir, { recursive: true });
    const sock = join(runDir, "demo.sock");
    await writeRecord(runDir, { name: "demo", pid: process.pid, socketPath: sock, startedAt: new Date().toISOString() } as any);
    await writeFile(sock, "");
    const gw = new WebGateway(fakeManager() as any); // listMeshes → demo running; snapshot has live agents
    const r = await handleApi(gw, "GET", "/api/diagnostics/ps", undefined, new URLSearchParams(), undefined, undefined, undefined, { root });
    expect(r.status).toBe(200);
    const mesh = (r.body.running as any[]).find((m) => m.name === "demo");
    expect(mesh).toBeTruthy();
    expect(mesh.agents.length).toBeGreaterThan(0);
    // every agent carries one of the known activity states (live snapshot path, not "unknown" static)
    for (const a of mesh.agents) expect(["idle", "working", "unknown"]).toContain(a.activity);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("POST /api/diagnostics/reap requires same-origin request headers (CSRF)", async () => {
  const root = await mkdtemp(join(tmpdir(), "api-reap-csrf-"));
  try {
    const gw = new WebGateway(fakeManager() as any);
    const r = await handleApi(gw, "POST", "/api/diagnostics/reap", {}, new URLSearchParams(), undefined, undefined, undefined,
      { root, headers: new Headers({ origin: "http://evil.test" }), expectedOrigin: SAME_ORIGIN });
    expect(r.status).toBe(403);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("POST /api/diagnostics/reap: reaps stale/orphan leaks, keeps the live daemon, returns fresh ps", async () => {
  const { writeRecord, readRecord } = await import("../mesh-registry");
  const root = await mkdtemp(join(tmpdir(), "api-reap-"));
  try {
    const runDir = join(root, "run");
    await mkdir(runDir, { recursive: true });
    await writeRecord(runDir, { name: "live", pid: process.pid, socketPath: join(runDir, "live.sock"), startedAt: new Date().toISOString() } as any);
    await writeFile(join(runDir, "live.sock"), "");
    await writeRecord(runDir, { name: "stale", pid: 2147483646, socketPath: join(runDir, "stale.sock"), startedAt: new Date().toISOString() } as any);
    await writeFile(join(runDir, "orphan.sock"), ""); // socket, no record

    const gw = new WebGateway(fakeManager() as any);
    const r = await handleApi(gw, "POST", "/api/diagnostics/reap", {}, new URLSearchParams(), undefined, undefined, undefined, { root, ...sameOriginCtx() });

    expect(r.status).toBe(200);
    expect([...r.body.reaped].sort()).toEqual(["orphan", "stale"]);
    expect(r.body.ps.leaks).toEqual([]);                                            // fresh ps: leaks cleared
    expect((r.body.ps.running as any[]).some((m) => m.name === "live")).toBe(true);  // live daemon survives
    expect(await readRecord(runDir, "live")).toBeDefined();
    expect(await readRecord(runDir, "stale")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("POST /api/diagnostics/reap fails with 500 when no diagnostics root is configured", async () => {
  const gw = new WebGateway(fakeManager() as any);
  expect((await handleApi(gw, "POST", "/api/diagnostics/reap", {}, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx())).status).toBe(500);
});

// ── Step 7.4-C — notification center REST + producers ─────────────────────────────
test("GET /api/notifications: empty store → empty page", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(gw, "GET", "/api/notifications", undefined);
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ items: [], unreadCount: 0, revision: 0, nextCursor: null });
});

test("notifications POST routes require same-origin (CSRF)", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const evil = { headers: new Headers({ origin: "http://evil.test" }), expectedOrigin: SAME_ORIGIN };
  for (const path of ["/api/notifications/read-all", "/api/notifications/cleanup", "/api/notifications/ntf-1/read"]) {
    const r = await handleApi(gw, "POST", path, {}, new URLSearchParams(), undefined, undefined, undefined, evil);
    expect(r.status).toBe(403);
  }
});

test("producer: GET /api/harnesses emits a harness-upgrade notification for outdated rows", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const probe = (async () => [
    { id: "codex", label: "Codex", installed: true, version: "1.2.3", latest: "1.2.5", outdated: true, auth: "ok", installable: "npm", lastProbeAt: 0, runningAgentsUsingOldVersion: [] },
    { id: "claude", label: "Claude", installed: true, version: "1.4.2", latest: "1.4.2", outdated: false, auth: "ok", installable: "npm", lastProbeAt: 0, runningAgentsUsingOldVersion: [] },
  ]) as any;
  await handleApi(gw, "GET", "/api/harnesses", undefined, new URLSearchParams(), probe);
  const list = gw.listNotifications();
  expect(list.items.length).toBe(1);
  expect(list.items[0].type).toBe("harness-upgrade");
  expect(list.items[0].dedupKey).toBe("harness-upgrade:codex:1.2.5");
  // idempotent: a second probe of the same versions does not duplicate or grow unread
  await handleApi(gw, "GET", "/api/harnesses", undefined, new URLSearchParams(), probe);
  expect(gw.listNotifications().items.length).toBe(1);
});

test("producer: POST /api/auth/device/start emits a device-auth notification (informational)", async () => {
  const root = await mkdtemp(join(tmpdir(), "api-notif-dev-"));
  try {
    const gw = new WebGateway(fakeManager() as any);
    const r = await handleApi(gw, "POST", "/api/auth/device/start", undefined, new URLSearchParams(), undefined, undefined, undefined, { root });
    expect(r.status).toBe(200);
    const list = gw.listNotifications();
    expect(list.items.some((n) => n.type === "device-auth" && n.dedupKey === `device-auth:${r.body.deviceId}`)).toBe(true);
    // source is a structured /bnw target (never an arbitrary URL)
    expect(list.items.find((n) => n.type === "device-auth")?.source).toEqual({ surface: "settings", tab: "devices" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notifications mark-read flow: list → mark one read → unread drops", async () => {
  const gw = new WebGateway(fakeManager() as any);
  await gw.emitNotification({ type: "system-alert", title: "alert", dedupKey: "k1" });
  const id = gw.listNotifications().items[0].id;
  const read = await handleApi(gw, "POST", `/api/notifications/${id}/read`, {}, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  expect(read.status).toBe(200);
  expect(read.body.unreadCount).toBe(0);
  const all = await handleApi(gw, "POST", "/api/notifications/read-all", {}, new URLSearchParams(), undefined, undefined, undefined, sameOriginCtx());
  expect(all.status).toBe(200);
});
