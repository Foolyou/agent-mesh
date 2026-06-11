import { test, expect } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "./api";
import { WebGateway } from "./gateway";
import type { MeshEvent, MeshConfig } from "../acp/types";

const CFG: MeshConfig = {
  name: "demo",
  agents: [
    { id: "router", harness: "claude", project: "p", role: "router" },
    { id: "codex-1", harness: "codex", project: "p", role: "member" },
  ],
  edges: [{ from: "router", to: "codex-1" }],
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function fakeManager(config: MeshConfig = CFG) {
  const calls: any[] = [];
  return {
    calls,
    on(_l: (n: string, e: MeshEvent) => void) {
      return () => {};
    },
    listMeshes() {
      return [{ name: "demo", defined: true, status: "running" as const }];
    },
    configOf() {
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
    async newAllSessions(n: string) {
      calls.push(["newAllSessions", n]);
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
    { id: "newbie", harness: "codex", project: "p", role: "member", lazy: undefined, effort: undefined, mode: undefined, model: undefined, instructions: undefined },
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

test("POST /api/master/prompt returns 409 when master absent", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const r = await handleApi(gw, "POST", "/api/master/prompt", { text: "hi" });
  expect(r.status).toBe(409);
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
