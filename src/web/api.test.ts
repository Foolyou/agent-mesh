import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
  edges: [["router", "codex-1"]],
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function fakeManager() {
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
      return CFG;
    },
    routerOf() {
      return "router";
    },
    async startMesh(n: string) {
      calls.push(["start", n]);
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
  expect(m.calls).toContainEqual(["start", "demo"]);
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
