import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig, MeshEvent } from "./acp/types";
import type { MeshServicesHandlers, MeshServicesServer, MeshToolContext } from "./mcp/mesh-services";
import { ControlPlane, MAX_ATTACHMENT_LABEL_CHARS } from "./control-plane";

// A valid 1x1 PNG (correct magic bytes) so the artifact image-sniff guard accepts it.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4DwQACfsD/aDefpkAAAAASUVErkJggg==";

class StubConnection {
  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> { return {}; }
  async newSession(): Promise<unknown> { return {}; }
  async loadSession(): Promise<unknown> { return {}; }
  async prompt(): Promise<unknown> { return {}; }
  async steerPrompt(): Promise<unknown> { return {}; }
  removeQueued(): unknown[] { return []; }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setConfigOption(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {}
}

class FakeServer implements MeshServicesServer {
  constructor(readonly handlers: MeshServicesHandlers) {}
  async register(): Promise<void> {}
  urlFor(id: string): string { return `http://127.0.0.1:0/${id}/mcp`; }
  get port(): number { return 0; }
  close(): void {}
}

const DEV: MeshToolContext = { agentId: "dev", role: "member" };

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cp-artifact-publish-"));
  // Both agents lazy → start() registers the mesh-services factory but spawns nothing.
  const config: MeshConfig = {
    name: "pub",
    agents: [
      { id: "router", harness: "claude", project: ".", role: "router", lazy: true },
      { id: "dev", harness: "claude", project: ".", role: "member", lazy: true },
    ],
    edges: [],
  };
  let captured: MeshServicesHandlers | undefined;
  const events: MeshEvent[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: join(root, "run"),
    artifactsRoot: root,
    connectionFactory: (opts) => new StubConnection(opts) as unknown as AcpAgentConnection,
    meshServicesFactory: (handlers) => { captured = handlers; return new FakeServer(handlers); },
  });
  cp.on((e) => events.push(e));
  await cp.start();
  const devDir = join(root, "artifacts", "pub", "dev");
  await mkdir(devDir, { recursive: true });
  return { root, cp, handlers: captured!, events, devDir };
}

function published(events: MeshEvent[]): Extract<MeshEvent, { kind: "attachment_published" }>[] {
  return events.filter((e): e is Extract<MeshEvent, { kind: "attachment_published" }> => e.kind === "attachment_published");
}

test("publishAttachment derives owner from ctx and emits a first-class event with content type + caption", async () => {
  const { root, cp, handlers, events } = await setup();
  try {
    await writeFile(join(root, "artifacts", "pub", "dev", "report.md"), "# hello\n");
    const result = await handlers.publishAttachment(DEV, "report.md", { caption: "  weekly report  " });
    expect(result).toBe("published report.md");
    const pubs = published(events);
    expect(pubs.length).toBe(1);
    expect(pubs[0]).toMatchObject({
      kind: "attachment_published",
      agent: "dev",
      path: "report.md",
      caption: "weekly report",
      contentType: "text/markdown; charset=utf-8",
    });
    expect(typeof pubs[0].ts).toBe("string");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("publishAttachment accepts a valid PNG and reports an image content type", async () => {
  const { root, cp, handlers, events } = await setup();
  try {
    await writeFile(join(root, "artifacts", "pub", "dev", "chart.png"), Buffer.from(PNG_B64, "base64"));
    const result = await handlers.publishAttachment(DEV, "chart.png");
    expect(result).toBe("published chart.png");
    expect(published(events)[0]).toMatchObject({ agent: "dev", path: "chart.png", contentType: "image/png" });
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("publishAttachment rejects dangerous or invalid files BEFORE emitting any event", async () => {
  const { root, cp, handlers, events } = await setup();
  const devDir = join(root, "artifacts", "pub", "dev");
  try {
    // bad image magic (text masquerading as png) and a non-whitelisted SVG
    await writeFile(join(devDir, "fake.png"), "not really a png");
    await writeFile(join(devDir, "evil.svg"), "<svg onload=alert(1)></svg>");
    // oversized file (> 5MiB)
    await writeFile(join(devDir, "huge.md"), "a".repeat(5 * 1024 * 1024 + 1));
    // a symlink whose first path component is a link → traversal/symlink guard
    await symlink(join(root, "secret.txt"), join(devDir, "link.md"));

    const cases = [
      ["../../etc/passwd", "traversal"],
      ["/etc/passwd", "absolute"],
      ["..%2f..%2fetc%2fpasswd", "encoded traversal"],
      ["sub\\..\\..\\escape.md", "backslash traversal"],
      ["fake.png", "bad image magic"],
      ["evil.svg", "non-whitelisted svg"],
      ["huge.md", "oversized"],
      ["link.md", "symlink"],
      ["missing.md", "missing"],
    ] as const;

    for (const [path, why] of cases) {
      const result = await handlers.publishAttachment(DEV, path);
      expect(result, `expected error for ${why} (${path})`).toStartWith("error:");
    }
    expect(published(events).length, "no events for any rejected file").toBe(0);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("publishAttachment without configured artifact storage is a clean error, not a throw", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-artifact-noroot-"));
  const config: MeshConfig = {
    name: "pub",
    agents: [{ id: "dev", harness: "claude", project: ".", role: "member", lazy: true }],
    edges: [],
  };
  let captured: MeshServicesHandlers | undefined;
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: join(root, "run"),
    // no artifactsRoot
    connectionFactory: (opts) => new StubConnection(opts) as unknown as AcpAgentConnection,
    meshServicesFactory: (handlers) => { captured = handlers; return new FakeServer(handlers); },
  });
  try {
    await cp.start();
    const result = await captured!.publishAttachment(DEV, "report.md");
    expect(result).toStartWith("error:");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated publishes are NOT deduped and all replay through snapshotEvents()", async () => {
  const { root, cp, handlers } = await setup();
  try {
    await writeFile(join(root, "artifacts", "pub", "dev", "report.md"), "# hello\n");
    await handlers.publishAttachment(DEV, "report.md", { caption: "v1" });
    await handlers.publishAttachment(DEV, "report.md", { caption: "v2" });

    const snap = published(cp.snapshotEvents());
    expect(snap.length).toBe(2);
    expect(snap.map((e) => e.caption)).toEqual(["v1", "v2"]);
    expect(snap.every((e) => e.agent === "dev" && e.path === "report.md")).toBe(true);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("caption and name are bounded to MAX_ATTACHMENT_LABEL_CHARS so the card payload stays small", async () => {
  const { root, cp, handlers, events } = await setup();
  try {
    await writeFile(join(root, "artifacts", "pub", "dev", "report.md"), "# hi\n");
    const huge = "x".repeat(MAX_ATTACHMENT_LABEL_CHARS + 500);
    await handlers.publishAttachment(DEV, "report.md", { caption: huge, name: huge });
    const pub = published(events)[0];
    expect(pub.caption!.length).toBe(MAX_ATTACHMENT_LABEL_CHARS);
    expect(pub.name!.length).toBe(MAX_ATTACHMENT_LABEL_CHARS);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("mesh_publish_attachment permission requests are auto-approved as an internal mesh tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-artifact-perm-"));
  const config: MeshConfig = {
    name: "perm",
    agents: [{ id: "r", harness: "claude", project: ".", role: "router" }],
    edges: [],
  };
  let conn: StubConnection | undefined;
  const events: MeshEvent[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: join(root, "run"),
    artifactsRoot: root,
    connectionFactory: (opts) => (conn = new StubConnection(opts)) as unknown as AcpAgentConnection,
    meshServicesFactory: (handlers) => new FakeServer(handlers),
  });
  cp.on((e) => events.push(e));
  try {
    await cp.start(); // eager spawn wires opts.onPermission
    const onPermission = conn!.opts.onPermission!;
    const opt = [{ optionId: "ok", kind: "allow_once", name: "Allow" }];

    // Both the bare and the mcp__mesh__-namespaced tool name must auto-approve without escalating.
    for (const toolName of ["mesh_publish_attachment", "mcp__mesh__mesh_publish_attachment"]) {
      const decision = await onPermission({ toolCall: { toolName }, options: opt });
      expect(decision).toEqual({ optionId: "ok" });
    }
    // No human-escalation permission events were emitted for the mesh tool.
    expect(events.some((e) => e.kind === "permission")).toBe(false);

    // Control: a non-mesh tool DOES escalate (emits a permission event); leave it pending.
    void onPermission({ toolCall: { toolName: "Bash" }, options: opt });
    await new Promise((r) => setTimeout(r, 10));
    expect(events.some((e) => e.kind === "permission")).toBe(true);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("issue-panel Phase 1 board tools (board_dispatch / board_lifecycle) auto-approve like other board tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-board-perm-"));
  const config: MeshConfig = {
    name: "perm",
    agents: [{ id: "r", harness: "claude", project: ".", role: "router" }],
    edges: [],
  };
  let conn: StubConnection | undefined;
  const events: MeshEvent[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: join(root, "run"),
    artifactsRoot: root,
    connectionFactory: (opts) => (conn = new StubConnection(opts)) as unknown as AcpAgentConnection,
    meshServicesFactory: (handlers) => new FakeServer(handlers),
  });
  cp.on((e) => events.push(e));
  try {
    await cp.start();
    const onPermission = conn!.opts.onPermission!;
    const opt = [{ optionId: "ok", kind: "allow_once", name: "Allow" }];

    // Both the bare and the mcp__mesh__-namespaced forms of the new board tools must auto-approve.
    for (const toolName of ["board_dispatch", "mcp__mesh__board_dispatch", "board_lifecycle", "mcp__mesh__board_lifecycle"]) {
      const decision = await onPermission({ toolCall: { toolName }, options: opt });
      expect(decision).toEqual({ optionId: "ok" });
    }
    expect(events.some((e) => e.kind === "permission")).toBe(false);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("issue-panel Phase 4 label tools auto-approve (bare + mcp__mesh__ forms)", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-label-perm-"));
  const config: MeshConfig = {
    name: "perm",
    agents: [{ id: "r", harness: "claude", project: ".", role: "router" }],
    edges: [],
  };
  let conn: StubConnection | undefined;
  const events: MeshEvent[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: join(root, "run"),
    artifactsRoot: root,
    connectionFactory: (opts) => (conn = new StubConnection(opts)) as unknown as AcpAgentConnection,
    meshServicesFactory: (handlers) => new FakeServer(handlers),
  });
  cp.on((e) => events.push(e));
  try {
    await cp.start();
    const onPermission = conn!.opts.onPermission!;
    const opt = [{ optionId: "ok", kind: "allow_once", name: "Allow" }];
    for (const toolName of [
      "board_create_label", "mcp__mesh__board_create_label",
      "board_update_label", "mcp__mesh__board_update_label",
      "board_delete_label", "mcp__mesh__board_delete_label",
      "board_set_task_labels", "mcp__mesh__board_set_task_labels",
    ]) {
      const decision = await onPermission({ toolCall: { toolName }, options: opt });
      expect(decision).toEqual({ optionId: "ok" });
    }
    expect(events.some((e) => e.kind === "permission")).toBe(false);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
