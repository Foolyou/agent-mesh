import { test, expect } from "bun:test";
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

function fakeManager() {
  let listener: ((n: string, e: MeshEvent) => void) | null = null;
  const calls: any[] = [];
  let alive = true;
  return {
    calls,
    emit(n: string, e: MeshEvent) {
      listener?.(n, e);
    },
    on(l: any) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    listMeshes() {
      return alive ? [{ name: "demo", defined: true, status: "running" as const }] : [];
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
    setMode(n: string, a: string, m: string) {
      calls.push(["setMode", n, a, m]);
    },
    interruptAgent(n: string, a: string) {
      calls.push(["interrupt", n, a]);
    },
    async defineMesh(c: MeshConfig) {
      calls.push(["define", c.name]);
    },
    async deleteMesh(n: string) {
      calls.push(["delete", n]);
      alive = false;
    },
    async loadDefinitions() {
      calls.push(["reload"]);
    },
    async stopAll() {},
  };
}

test("snapshot includes meshes with composed agent rows", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const s = gw.snapshot();
  expect(s.meshes[0]).toMatchObject({ name: "demo", status: "running", router: "router" });
  expect(s.meshes[0].agents.map((a) => a.id)).toEqual(["router", "codex-1"]);
});

test("update event folds into the agent transcript and broadcasts a transcript op", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg)); // first msg is snapshot
  m.emit("demo", {
    kind: "update",
    agent: "router",
    update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } } as any,
    ts: "T",
  });
  const up = got.find((x) => x.t === "transcript.upsert");
  expect(up.conv).toMatchObject({ scope: "agent", mesh: "demo", agent: "router" });
  expect(up.item).toMatchObject({ kind: "message", text: "hi" });
  expect((gw.snapshot().perMesh.demo.transcripts.router[0] as any).text).toBe("hi");
});

test("permission add then resolved updates pending + history + activity", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", {
    kind: "permission",
    agent: "codex-1",
    requestId: "r1",
    question: "run?",
    options: [{ id: "allow", name: "Allow" }],
    ts: "T",
  });
  expect(gw.snapshot().perMesh.demo.pending).toHaveLength(1);
  expect(got.some((x) => x.t === "permission.add")).toBe(true);
  m.emit("demo", {
    kind: "permission_resolved",
    agent: "codex-1",
    requestId: "r1",
    optionId: "allow",
    by: "human",
    ts: "T",
  });
  const s = gw.snapshot();
  expect(s.perMesh.demo.pending).toHaveLength(0);
  expect(s.perMesh.demo.history).toHaveLength(1);
  expect(s.perMesh.demo.activity.some((a) => a.kind === "permission_resolved")).toBe(true);
});

test("mail event emits both activity and mail entries", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", { kind: "mail", from: "router", to: "codex-1", body: "ping", ts: "T" });
  const s = gw.snapshot();
  expect(s.perMesh.demo.mail).toHaveLength(1);
  expect(s.perMesh.demo.activity.some((a) => a.kind === "mail")).toBe(true);
  expect(got.some((x) => x.t === "mail")).toBe(true);
  expect(got.some((x) => x.t === "activity")).toBe(true);
});

test("command methods delegate to the manager", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  await gw.startMesh("demo");
  await gw.promptRouter("demo", "go");
  gw.resolvePermission("demo", "r1", "allow");
  expect(m.calls).toContainEqual(["start", "demo"]);
  expect(m.calls).toContainEqual(["promptRouter", "demo", "go", []]);
  expect(m.calls).toContainEqual(["resolve", "demo", "r1", "allow"]);
});

test("promptRouter echoes a user message into the router transcript", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  await gw.promptRouter("demo", "hello");
  const tr = gw.snapshot().perMesh.demo.transcripts.router;
  expect(tr[tr.length - 1]).toMatchObject({ kind: "message", role: "user", text: "hello" });
});

test("promptRouter threads images to manager and user transcript", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any, undefined, { root: "/tmp/root" });
  await gw.promptRouter("demo", "see", [{ id: "abc.png", mimeType: "image/png", name: "abc.png" }]);
  expect(m.calls[m.calls.length - 1][0]).toBe("promptRouter");
  expect(m.calls[m.calls.length - 1][3][0]).toMatchObject({ id: "abc.png", bucket: "demo", url: "/api/uploads/demo/abc.png" });
  const tr = gw.snapshot().perMesh.demo.transcripts.router;
  const broadcastImg = (tr[tr.length - 1] as any).images[0];
  expect(broadcastImg).toMatchObject({ name: "abc.png", url: "/api/uploads/demo/abc.png" });
  // the broadcast/persisted transcript must NOT leak the absolute server path or internal bucket
  expect(broadcastImg.path).toBeUndefined();
  expect(broadcastImg.bucket).toBeUndefined();
});

test("promptRouter ignores a client-supplied image path/bucket/url (no arbitrary file read)", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any, undefined, { root: "/tmp/root" });
  // a malicious client tries to smuggle an absolute path + foreign bucket + url
  await gw.promptRouter("demo", "see", [
    { id: "abc.png", mimeType: "image/png", name: "x", path: "/etc/passwd", bucket: "../../etc", url: "http://evil/x" } as any,
  ]);
  const ref = m.calls[m.calls.length - 1][3][0];
  // path is reconstructed server-side from the configured root + server-chosen bucket + validated id
  expect(ref.path).toBe("/tmp/root/uploads/demo/abc.png");
  expect(ref.bucket).toBe("demo");
  expect(ref.url).toBe("/api/uploads/demo/abc.png");
});

test("promptRouter drops an image with a malformed id (no path → skipped, not read off disk)", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any, undefined, { root: "/tmp/root" });
  await gw.promptRouter("demo", "see", [{ id: "../../../etc/passwd", mimeType: "image/png", name: "x" } as any]);
  const ref = m.calls[m.calls.length - 1][3][0];
  expect(ref.path).toBeUndefined();
  expect(ref.url).toBeUndefined();
});

test("agent_capabilities updates gateway state and broadcasts", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", { kind: "agent_capabilities", agent: "router", image: true, ts: "T" });
  expect(gw.snapshot().perMesh.demo.capabilities.router.image).toBe(true);
  expect(got).toContainEqual({ t: "agent.capabilities", name: "demo", agent: "router", image: true });
});

test("agent_status updates the mesh summary agent row", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  m.emit("demo", { kind: "agent_status", agent: "codex-1", status: "ready", ts: "T" });
  const row = gw.snapshot().meshes[0].agents.find((a) => a.id === "codex-1");
  expect(row?.status).toBe("ready");
});

test("promptMaster throws when no master is configured", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  expect(gw.snapshot().master.status).toBe("absent");
  expect(gw.promptMaster("hi")).rejects.toThrow();
});

test("deleteMesh delegates and prunes perMesh state", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  m.emit("demo", { kind: "log", text: "hi", ts: "T" }); // seed perMesh
  expect(gw.snapshot().perMesh.demo).toBeDefined();
  await gw.deleteMesh("demo");
  expect(m.calls).toContainEqual(["delete", "demo"]);
  expect(gw.snapshot().perMesh.demo).toBeUndefined();
});
