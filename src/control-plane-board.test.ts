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
const bob: MeshToolContext = { agentId: "bob", role: "member" };

function config(): MeshConfig {
  return {
    name: MESH,
    agents: [
      { id: "router", harness: "claude", project: ".", role: "router", lazy: true },
      { id: "alice", harness: "claude", project: ".", role: "member", lazy: true },
      { id: "bob", harness: "claude", project: ".", role: "member", lazy: true },
    ],
    // Dispatch mails router→member; lifecycle markers ride member→router replies.
    edges: [
      { from: "router", to: "alice" },
      { from: "router", to: "bob" },
      { from: "alice", to: "router" },
      { from: "bob", to: "router" },
    ],
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

test("the router creates a task: it lands in memory, persists to disk, and emits a board_snapshot", async () => {
  const h = await setup();
  try {
    const res = await h.handlers.applyBoard(router, { type: "create_task", title: "do it" }, 0);
    expect(res).toContain("ok: task #1");

    expect(h.cp.getBoard().tasks).toHaveLength(1);
    expect(h.cp.getBoard().tasks[0]).toMatchObject({ id: 1, title: "do it", createdBy: "router" });

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
    await h.handlers.applyBoard(router, { type: "create_task", title: "t" }, 0); // board rev → 1
    const stale = await h.handlers.applyBoard(router, { type: "create_task", title: "again" }, 0); // stale token
    expect(stale).toContain("error:");
    expect(stale.toLowerCase()).toContain("conflict");
    expect(h.cp.getBoard().tasks).toHaveLength(1);
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("members cannot create tasks (router/operator only)", async () => {
  const h = await setup();
  try {
    const denied = await h.handlers.applyBoard(alice, { type: "create_task", title: "t" }, 0);
    expect(denied).toContain("error:");
    expect(h.cp.getBoard().tasks).toHaveLength(0);
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("an assignee may move its own task to in_review but not to done", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_task", title: "t", assignee: "alice" }, 0); // #1 → alice
    const review = await h.handlers.applyBoard(alice, { type: "set_task_status", id: 1, expectedRevision: 1, status: "in_review" }, 1);
    expect(review).toContain("ok:");
    const done = await h.handlers.applyBoard(alice, { type: "set_task_status", id: 1, expectedRevision: 2, status: "done" }, 1);
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
    await h.handlers.applyBoard(router, { type: "create_task", title: "t" }, 1);
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

// ── issue-panel Phase 1: dispatch + lifecycle reflux (real ControlPlane path) ──

function mails(events: MeshEvent[]): Extract<MeshEvent, { kind: "mail" }>[] {
  return events.filter((e): e is Extract<MeshEvent, { kind: "mail" }> => e.kind === "mail");
}
const task1 = (h: Harness) => h.cp.getBoard().tasks.find((t) => t.id === 1)!;

test("board_dispatch: atomic hand-off → in_progress + assignee + exactly one mail + linkage", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_task", title: "do it" }, 0);
    const before = h.events.length;
    const board = h.cp.getBoard();
    const res = await h.handlers.dispatchBoard(router, {
      taskId: 1, assignee: "alice", slug: "feat-x", brief: "build the thing",
      expectedRevision: board.tasks[0].revision, expectedBoardRevision: board.revision,
    });
    expect(res).toContain("dispatched #1 to alice");

    const t = task1(h);
    expect(t.status).toBe("in_progress");
    expect(t.assignee).toBe("alice");
    expect(t.taskSlug).toBe("feat-x");
    expect(t.branchName).toBe("task/feat-x");
    expect(t.dispatch).toMatchObject({ assignee: "alice", threadKey: "feat-x" });
    expect(t.dispatch?.mailEventId).toBeTruthy();
    expect(t.dispatch?.mailFailed).toBe(false);

    // exactly ONE mail, carrying the ref + slug + brief, and the link is recorded both ways.
    const sent = mails(h.events.slice(before)).filter((m) => m.to === "alice");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("#1");
    expect(sent[0].body).toContain("feat-x");
    expect(sent[0].body).toContain("build the thing");
    expect(sent[0].id).toBeTruthy();
    expect(t.mailEventIds).toContain(sent[0].id!);

    // AUTHORITATIVE dispatch is a SINGLE atomic snapshot: the first new snapshot already carries
    // assignee + slug + branch + dispatched/in_progress together — never a chained assign→linkage→
    // lifecycle sequence of partial-state snapshots.
    const newSnaps = snapshots(h.events.slice(before));
    const first = newSnaps[0]?.board.tasks.find((x) => x.id === 1)!;
    expect(first).toMatchObject({ status: "in_progress", assignee: "alice", taskSlug: "feat-x", branchName: "task/feat-x" });
    expect(first.lifecycleEvents?.some((e) => e.kind === "dispatched")).toBe(true);
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("review_requested via the board_lifecycle tool moves the assignee's card to in_review", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_task", title: "t" }, 0);
    const b = h.cp.getBoard();
    await h.handlers.dispatchBoard(router, { taskId: 1, assignee: "alice", slug: "s", expectedRevision: b.tasks[0].revision, expectedBoardRevision: b.revision });
    expect(task1(h).status).toBe("in_progress");
    // assignee alice signals review via the tool (applyBoard → record_lifecycle_event)
    const okRes = await h.handlers.applyBoard(alice, { type: "record_lifecycle_event", taskId: 1, expectedRevision: task1(h).revision, kind: "review_requested", threadKey: "s" }, h.cp.getBoard().revision);
    expect(okRes).not.toContain("error:");
    expect(task1(h).status).toBe("in_review");
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("review_requested via a mail marker (structured field AND leading [REVIEW]) → in_review", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_task", title: "t" }, 0);
    let b = h.cp.getBoard();
    await h.handlers.dispatchBoard(router, { taskId: 1, assignee: "alice", slug: "feat-y", expectedRevision: b.tasks[0].revision, expectedBoardRevision: b.revision });

    // structured field on a slug-referenced mail moves the card (sender = assignee alice).
    const before = h.events.length;
    await h.handlers.sendMail(alice, "router", "[DONE] handing off", { task: "feat-y", lifecycle: "review_requested" });
    expect(task1(h).status).toBe("in_review");
    expect(mails(h.events.slice(before)).some((m) => m.from === "alice" && m.to === "router")).toBe(true); // mail still delivered

    // the prose fallback path on a FRESH task: a leading [REVIEW] token maps to review_requested.
    await h.handlers.applyBoard(router, { type: "create_task", title: "t2" }, h.cp.getBoard().revision);
    b = h.cp.getBoard();
    const t2 = b.tasks.find((t) => t.id === 2)!;
    await h.handlers.dispatchBoard(router, { taskId: 2, assignee: "alice", slug: "feat-y2", expectedRevision: t2.revision, expectedBoardRevision: b.revision });
    expect(h.cp.getBoard().tasks.find((t) => t.id === 2)!.status).toBe("in_progress");
    await h.handlers.sendMail(alice, "router", "[REVIEW] take a look", { task: "#2" });
    expect(h.cp.getBoard().tasks.find((t) => t.id === 2)!.status).toBe("in_review");
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("a non-assignee mail marker is a silent no-op, but the mail is still delivered", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_task", title: "t" }, 0);
    let b = h.cp.getBoard();
    await h.handlers.dispatchBoard(router, { taskId: 1, assignee: "alice", slug: "feat-z", expectedRevision: b.tasks[0].revision, expectedBoardRevision: b.revision });
    expect(task1(h).status).toBe("in_progress");

    const before = h.events.length;
    // bob is NOT the assignee → reducer rejects the lifecycle event; status unchanged, mail delivered.
    await h.handlers.sendMail(bob, "router", "[REVIEW] poking", { task: "feat-z" });
    expect(task1(h).status).toBe("in_progress");
    expect(mails(h.events.slice(before)).some((m) => m.from === "bob")).toBe(true);
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("integration_ready sets closeReady but keeps status in_review (no auto-done)", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_task", title: "t" }, 0);
    let b = h.cp.getBoard();
    await h.handlers.dispatchBoard(router, { taskId: 1, assignee: "alice", slug: "s", expectedRevision: b.tasks[0].revision, expectedBoardRevision: b.revision });
    await h.handlers.applyBoard(alice, { type: "record_lifecycle_event", taskId: 1, expectedRevision: task1(h).revision, kind: "review_requested", threadKey: "s" }, h.cp.getBoard().revision);
    expect(task1(h).status).toBe("in_review");

    await h.handlers.applyBoard(router, { type: "record_lifecycle_event", taskId: 1, expectedRevision: task1(h).revision, kind: "integration_ready" }, h.cp.getBoard().revision);
    expect(task1(h).closeReady).toBe(true);
    expect(task1(h).status).toBe("in_review"); // NOT auto-advanced to done
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("done/cancelled stay privileged-close: a member is forbidden, the router may close", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_task", title: "t" }, 0);
    let b = h.cp.getBoard();
    await h.handlers.dispatchBoard(router, { taskId: 1, assignee: "alice", slug: "s", expectedRevision: b.tasks[0].revision, expectedBoardRevision: b.revision });
    const denied = await h.handlers.applyBoard(alice, { type: "set_task_status", id: 1, expectedRevision: task1(h).revision, status: "done" }, h.cp.getBoard().revision);
    expect(denied).toContain("error:");
    expect(task1(h).status).toBe("in_progress");
    const closed = await h.handlers.applyBoard(router, { type: "set_task_status", id: 1, expectedRevision: task1(h).revision, status: "done" }, h.cp.getBoard().revision);
    expect(closed).not.toContain("error:");
    expect(task1(h).status).toBe("done");
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("a member can neither board_dispatch nor mark integration_ready", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_task", title: "t", assignee: "alice" }, 0);
    const dispatchDenied = await h.handlers.dispatchBoard(alice, { taskId: 1, assignee: "alice", slug: "s", expectedRevision: task1(h).revision, expectedBoardRevision: h.cp.getBoard().revision });
    expect(dispatchDenied).toContain("error:");
    const intDenied = await h.handlers.applyBoard(alice, { type: "record_lifecycle_event", taskId: 1, expectedRevision: task1(h).revision, kind: "integration_ready" }, h.cp.getBoard().revision);
    expect(intDenied).toContain("error:");
    expect(task1(h).closeReady).toBeFalsy();
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("mail failure leaves assignment + in_progress intact and surfaces dispatch.mailFailed", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_task", title: "t" }, 0);
    const b = h.cp.getBoard();
    // dispatch to an agent the router cannot reach (no such agent) → mail fails AFTER the board commit.
    const res = await h.handlers.dispatchBoard(router, { taskId: 1, assignee: "ghost", slug: "s", expectedRevision: b.tasks[0].revision, expectedBoardRevision: b.revision });
    expect(res).toContain("MAIL FAILED");
    const t = task1(h);
    expect(t.assignee).toBe("ghost");
    expect(t.status).toBe("in_progress"); // not rolled back
    expect(t.dispatch?.mailFailed).toBe(true);
    expect(t.dispatch?.mailEventId).toBeUndefined();
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("idempotent re-dispatch / re-assign: no double transition, no status rollback", async () => {
  const h = await setup();
  try {
    await h.handlers.applyBoard(router, { type: "create_task", title: "t" }, 0);
    let b = h.cp.getBoard();
    await h.handlers.dispatchBoard(router, { taskId: 1, assignee: "alice", slug: "s", expectedRevision: b.tasks[0].revision, expectedBoardRevision: b.revision });
    await h.handlers.applyBoard(alice, { type: "record_lifecycle_event", taskId: 1, expectedRevision: task1(h).revision, kind: "review_requested", threadKey: "s" }, h.cp.getBoard().revision);
    expect(task1(h).status).toBe("in_review");

    // re-dispatch to the SAME assignee+slug: no second `dispatched`, status stays in_review.
    const beforeEvents = task1(h).lifecycleEvents?.filter((e) => e.kind === "dispatched").length;
    await h.handlers.dispatchBoard(router, { taskId: 1, assignee: "alice", slug: "s", expectedRevision: task1(h).revision, expectedBoardRevision: h.cp.getBoard().revision });
    expect(task1(h).lifecycleEvents?.filter((e) => e.kind === "dispatched").length).toBe(beforeEvents);
    expect(task1(h).status).toBe("in_review");

    // re-assign to bob: assignee flips, a fresh dispatched is appended, status does NOT regress.
    await h.handlers.dispatchBoard(router, { taskId: 1, assignee: "bob", slug: "s", expectedRevision: task1(h).revision, expectedBoardRevision: h.cp.getBoard().revision });
    expect(task1(h).assignee).toBe("bob");
    expect(task1(h).status).toBe("in_review");
    expect(task1(h).lifecycleEvents?.filter((e) => e.kind === "dispatched").length).toBe((beforeEvents ?? 0) + 1);
  } finally {
    await h.cp.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});
