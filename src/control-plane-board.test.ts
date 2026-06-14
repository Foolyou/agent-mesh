import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig, MeshEvent } from "./acp/types";
import type { MeshServicesHandlers, MeshServicesServer, MeshToolContext } from "./mcp/mesh-services";
import { ControlPlane } from "./control-plane";
import { createEmptyBoard, applyBoardCommand } from "./board";
import { boardsDirFor, readBoard, writeBoard } from "./board-store";

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

const MESH = "board-cp";
const router: MeshToolContext = { agentId: "router", role: "router" };
const alice: MeshToolContext = { agentId: "alice", role: "member" };

function config(): MeshConfig {
  return {
    name: MESH,
    agents: [
      { id: "router", harness: "claude", project: ".", role: "router", lazy: true },
      { id: "alice", harness: "claude", project: ".", role: "member", lazy: true },
    ],
    edges: [],
  };
}

interface Harness {
  root: string;
  cp: ControlPlane;
  handlers: MeshServicesHandlers;
  events: MeshEvent[];
  boardsDir: string;
}

async function setup(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "cp-board-"));
  let captured: MeshServicesHandlers | undefined;
  const events: MeshEvent[] = [];
  const cp = new ControlPlane(config(), {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: join(root, "run"),
    connectionFactory: (opts) => new StubConnection(opts) as unknown as AcpAgentConnection,
    meshServicesFactory: (handlers) => { captured = handlers; return new FakeServer(handlers); },
  });
  cp.on((e) => events.push(e));
  await cp.start();
  return { root, cp, handlers: captured!, events, boardsDir: boardsDirFor(root) };
}

function snapshots(events: MeshEvent[]): Extract<MeshEvent, { kind: "board_snapshot" }>[] {
  return events.filter((e): e is Extract<MeshEvent, { kind: "board_snapshot" }> => e.kind === "board_snapshot");
}

test("an agent creates a task: it lands in memory, persists to disk, and emits a board_snapshot", async () => {
  const h = await setup();
  try {
    const res = await h.handlers.applyBoard(alice, { type: "create_task", title: "do it" }, 0);
    expect(res).toContain("ok: task #1");

    expect(h.cp.getBoard().tasks).toHaveLength(1);
    expect(h.cp.getBoard().tasks[0]).toMatchObject({ id: 1, title: "do it", createdBy: "alice" });

    const onDisk = await readBoard(h.boardsDir, MESH);
    expect(onDisk.tasks).toHaveLength(1);
    expect(onDisk.revision).toBe(1);

    const snaps = snapshots(h.events);
    expect(snaps.at(-1)?.board.tasks).toHaveLength(1);
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("epic create is router-only via ctx.role (handler-side recheck)", async () => {
  const h = await setup();
  try {
    const denied = await h.handlers.applyBoard(alice, { type: "create_epic", title: "E" }, 0);
    expect(denied).toContain("error:");
    expect(h.cp.getBoard().epics).toHaveLength(0);

    const okRes = await h.handlers.applyBoard(router, { type: "create_epic", title: "E" }, 0);
    expect(okRes).toContain("ok: epic-1");
    expect(h.cp.getBoard().epics).toHaveLength(1);
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("board CAS conflict surfaces as an error string and does not mutate", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(alice, { type: "create_task", title: "t" }, 0); // board rev → 1
    const stale = await h.handlers.applyBoard(alice, { type: "create_task", title: "again" }, 0); // stale token
    expect(stale).toContain("error:");
    expect(stale.toLowerCase()).toContain("conflict");
    expect(h.cp.getBoard().tasks).toHaveLength(1);
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("an agent may move its own task to in_review but not to done", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(alice, { type: "create_task", title: "t" }, 0); // task #1 rev1, board rev1
    const review = await h.handlers.applyBoard(alice, { type: "set_task_status", id: 1, expectedRevision: 1, status: "in_review" }, 1);
    expect(review).toContain("ok:");
    const done = await h.handlers.applyBoard(alice, { type: "set_task_status", id: 1, expectedRevision: 2, status: "done" }, 2);
    expect(done).toContain("error:");
    expect(h.cp.getBoard().tasks[0].status).toBe("in_review");
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("board_list reports the board revision and the caller's own open tasks", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_task", title: "owned", assignee: "alice" }, 0); // #1 → alice
    const text = await h.handlers.boardList(alice);
    expect(text).toContain("board revision 1");
    expect(text).toContain("#1");
    // the JSON payload carries revisions for CAS
    expect(text).toContain('"revision"');
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("snapshotEvents() always replays the current full board", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_epic", title: "E" }, 0);
    await h.handlers.applyBoard(alice, { type: "create_task", title: "t" }, 1);
    const snap = (h.cp as unknown as { snapshotEvents(): MeshEvent[] }).snapshotEvents();
    const board = snap.find((e): e is Extract<MeshEvent, { kind: "board_snapshot" }> => e.kind === "board_snapshot");
    expect(board?.board.epics).toHaveLength(1);
    expect(board?.board.tasks).toHaveLength(1);
    expect(board?.board.revision).toBe(2);
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("an unknown command type is a clean invalid error, never a thrown exception", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_task", title: "real" }, 0); // board rev → 1
    // Malformed command (e.g. forward-compat JSON): must not throw, must not mutate.
    const res = await (h.handlers.applyBoard as (c: any, cmd: any, ebr: number) => Promise<string>)(router, { type: "frobnicate" }, 1);
    expect(res).toContain("error:");
    expect(h.cp.getBoard().tasks).toHaveLength(1);
    // a non-object command is also handled defensively
    const res2 = await (h.handlers.applyBoard as (c: any, cmd: any, ebr: number) => Promise<string>)(router, null, 1);
    expect(res2).toContain("error:");
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("an existing board file is loaded into memory on start", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-board-load-"));
  try {
    // Seed a board file before the control plane starts.
    let seed = createEmptyBoard(MESH);
    const r = applyBoardCommand(seed, { type: "create_task", title: "preexisting" }, { actor: { kind: "router", agentId: "x" }, now: "2026-06-14T00:00:00.000Z", expectedBoardRevision: 0 });
    if (r.ok) seed = r.state;
    await writeBoard(boardsDirFor(root), MESH, seed);

    let captured: MeshServicesHandlers | undefined;
    const cp = new ControlPlane(config(), {
      mailboxPath: join(root, "mailbox.ndjson"),
      sessionRunDir: join(root, "run"),
      connectionFactory: (opts) => new StubConnection(opts) as unknown as AcpAgentConnection,
      meshServicesFactory: (handlers) => { captured = handlers; return new FakeServer(handlers); },
    });
    await cp.start();
    expect(cp.getBoard().tasks).toHaveLength(1);
    expect(cp.getBoard().tasks[0].title).toBe("preexisting");
    expect(captured).toBeDefined();
    await cp.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
