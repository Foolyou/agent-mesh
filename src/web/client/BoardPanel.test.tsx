import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BoardPanel,
  BoardListView,
  BoardDetailView,
  parseBoardRoute,
  serializeBoardRoute,
  filterSortTasks,
  blockedTaskIds,
  parseDepsInput,
  depsCommit,
  EMPTY_FILTER,
  type BoardRoute,
  type BoardFilter,
} from "./BoardPanel";
import { I18nContext, translate } from "./i18n";
import { applyBoardCommand, createEmptyBoard, type BoardDocument, type BoardState } from "../../board";
import type { Store } from "./store";

interface MailLite { id: string; ts: string; from: string; to: string; body: string }
/** A minimal Store stub: the detail view reads recent mail via useStore(store).getState(). */
function makeStore(mail: MailLite[] = []): Store {
  const state = { perMesh: { demo: { mail } } } as unknown as ReturnType<Store["getState"]>;
  return {
    boardCommand: async () => ({ board: createEmptyBoard("m"), change: {} }),
    getBoard: async () => createEmptyBoard("m"),
    ensureBoardLoaded: async () => {},
    getState: () => state,
    subscribe: () => () => {},
  } as unknown as Store;
}
const noopStore = makeStore();

const ctx = (s: BoardState) => ({ actor: { kind: "router" as const, agentId: "lead" }, now: "2026-06-15T00:00:00.000Z", expectedBoardRevision: s.revision });

/** Build a small board (epic E1 + task #1 w/ subtask, comment, dep #2; #1 dispatched to alice). */
function sampleBoard(): BoardDocument {
  let s: BoardState = createEmptyBoard("demo");
  const step = (cmd: Parameters<typeof applyBoardCommand>[1]) => {
    const r = applyBoardCommand(s, cmd, ctx(s));
    if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
    s = r.state;
  };
  const rev = (id: number) => s.tasks.find((t) => t.id === id)!.revision;
  step({ type: "create_epic", title: "Launch" }); // epic-1
  step({ type: "create_task", title: "Wire it up", epicId: "epic-1" }); // #1
  step({ type: "create_task", title: "Dependency" }); // #2 (no epic)
  step({ type: "create_subtask", taskId: 1, expectedRevision: rev(1), title: "subtask A" });
  step({ type: "add_comment", target: { kind: "task", id: 1 }, expectedRevision: rev(1), text: "note" });
  step({ type: "set_task_deps", id: 1, expectedRevision: rev(1), deps: [2] });
  step({ type: "dispatch_task", id: 1, expectedRevision: rev(1), assignee: "alice", taskSlug: "wire-it" });
  return s;
}

function withI18n(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(I18nContext.Provider, { value: { lang: "en", t: (key, vars) => translate(key, "en", vars) } }, node),
  );
}

function renderPanel(board: BoardDocument | null, running: boolean, initialRoute?: BoardRoute): string {
  return withI18n(createElement(BoardPanel, { mesh: "demo", board, running, agents: ["router", "alice"], store: noopStore, initialRoute }));
}

// ── route helpers ───────────────────────────────────────────────────────────
test("parseBoardRoute: ?issue=N → detail, otherwise list", () => {
  expect(parseBoardRoute("?issue=5")).toEqual({ view: "detail", issue: 5 });
  expect(parseBoardRoute("?board=detail&issue=5")).toEqual({ view: "detail", issue: 5 });
  expect(parseBoardRoute("?board=list")).toEqual({ view: "list" });
  expect(parseBoardRoute("")).toEqual({ view: "list" });
  expect(parseBoardRoute("?issue=0")).toEqual({ view: "list" }); // invalid id ignored
  expect(parseBoardRoute("?issue=x")).toEqual({ view: "list" });
});

test("serializeBoardRoute round-trips and preserves unrelated params", () => {
  expect(serializeBoardRoute({ view: "detail", issue: 7 }, "?foo=1")).toBe("?foo=1&board=detail&issue=7");
  expect(parseBoardRoute(serializeBoardRoute({ view: "detail", issue: 7 }, ""))).toEqual({ view: "detail", issue: 7 });
  // list view drops board/issue but keeps other params
  expect(serializeBoardRoute({ view: "list" }, "?foo=1&board=detail&issue=7")).toBe("?foo=1");
  expect(serializeBoardRoute({ view: "list" }, "")).toBe("");
});

// ── filter / sort ─────────────────────────────────────────────────────────────
test("filterSortTasks filters by status/assignee/epic/text and sorts", () => {
  const s = sampleBoard();
  const tasks = s.tasks;
  expect(filterSortTasks(tasks, { ...EMPTY_FILTER, assignee: "alice" }).map((t) => t.id)).toEqual([1]);
  expect(filterSortTasks(tasks, { ...EMPTY_FILTER, assignee: "@unassigned" }).map((t) => t.id)).toEqual([2]);
  expect(filterSortTasks(tasks, { ...EMPTY_FILTER, epic: "epic-1" }).map((t) => t.id)).toEqual([1]);
  expect(filterSortTasks(tasks, { ...EMPTY_FILTER, epic: "@none" }).map((t) => t.id)).toEqual([2]);
  expect(filterSortTasks(tasks, { ...EMPTY_FILTER, text: "wire" }).map((t) => t.id)).toEqual([1]);
  expect(filterSortTasks(tasks, { ...EMPTY_FILTER, text: "#2" }).map((t) => t.id)).toEqual([2]);
  expect(filterSortTasks(tasks, { ...EMPTY_FILTER, status: "in_progress" }).map((t) => t.id)).toEqual([1]); // dispatched → in_progress
  expect(filterSortTasks(tasks, { ...EMPTY_FILTER, sort: "id" }).map((t) => t.id)).toEqual([1, 2]);
});

test("blockedTaskIds folds DAG warnings (incomplete dependency)", () => {
  // #1 is in_progress (dispatched) and depends on #2 (todo) → blocked-by-incomplete.
  const blocked = blockedTaskIds(sampleBoard());
  expect(blocked.has(1)).toBe(true);
  expect(blocked.has(2)).toBe(false);
});

// ── list view render ────────────────────────────────────────────────────────
test("list view renders issue rows with id, title, status chip, assignee, priority, progress", () => {
  const html = renderPanel(sampleBoard(), true);
  expect(html).toContain("board-issue");
  expect(html).toContain("#1");
  expect(html).toContain("Wire it up");
  expect(html).toContain("st-in_progress"); // status chip
  expect(html).toContain("@alice"); // assignee display
  expect(html).toContain("0/1"); // subtask progress
  expect(html).toContain("blocked"); // blocked badge from DAG warning
  expect(html).toContain("board-filter"); // filter bar present
  expect(html).toContain("rev "); // CAS context
});

test("list view never exposes an editable assignee control (§4: panel must not assign)", () => {
  const html = renderPanel(sampleBoard(), true);
  // the running list shows the filter/sort selects, but no per-row assignee <select>
  expect(html).not.toContain('title="assignee"');
});

test("running shows the create row; stopped mesh hides create inputs", () => {
  expect(renderPanel(sampleBoard(), true)).toContain("board-create");
  expect(renderPanel(sampleBoard(), false)).not.toContain("board-create");
});

test("BoardListView with group-by-epic renders epic + orphan groups", () => {
  const html = withI18n(createElement(BoardListView, { board: sampleBoard(), filter: EMPTY_FILTER, groupByEpic: true, onOpen: () => {} }));
  expect(html).toContain("board-group");
  expect(html).toContain("E1 Launch"); // epic group label
  expect(html).toContain("no epic"); // orphan bucket
});

test("filter with no matches shows the no-matches empty state", () => {
  const filter: BoardFilter = { ...EMPTY_FILTER, text: "zzz-nothing" };
  const html = withI18n(createElement(BoardListView, { board: sampleBoard(), filter, groupByEpic: false, onOpen: () => {} }));
  expect(html).toContain("no issues match");
});

// ── detail view (C1: read-only) ───────────────────────────────────────────────
test("detail view (deep-link route) renders title, slug/branch, lifecycle timeline, and a back button", () => {
  const html = renderPanel(sampleBoard(), true, { view: "detail", issue: 1 });
  expect(html).toContain("board-detail");
  expect(html).toContain("#1");
  expect(html).toContain("Wire it up");
  expect(html).toContain("wire-it"); // taskSlug
  expect(html).toContain("task/wire-it"); // branchName
  expect(html).toContain("board-lc-pill"); // lifecycle timeline pill (dispatched)
  expect(html).toContain("dispatched");
  expect(html).toContain("board-back"); // back affordance
});

test("a deep-link to a missing issue falls back to the list", () => {
  const html = renderPanel(sampleBoard(), true, { view: "detail", issue: 999 });
  expect(html).toContain("board-issue"); // list rows, not a detail
  expect(html).not.toContain("board-detail");
});

/** sampleBoard + a linked mail (evt-2 via link_mail) and a dispatch mail id (evt-1). */
function sampleBoardWithMail(): BoardDocument {
  let s = sampleBoard();
  const rev = () => s.tasks.find((t) => t.id === 1)!.revision;
  let r = applyBoardCommand(s, { type: "set_dispatch_mail", taskId: 1, expectedRevision: rev(), mailEventId: "evt-1" }, ctx(s));
  if (r.ok) s = r.state;
  r = applyBoardCommand(s, { type: "link_mail", taskId: 1, expectedRevision: rev(), mailEventId: "evt-2" }, { actor: { kind: "system" }, now: "2026-06-15T00:00:00.000Z", expectedBoardRevision: s.revision });
  if (r.ok) s = r.state;
  return s;
}

function renderDetail(board: BoardDocument, running: boolean, store: Store): string {
  const task = board.tasks.find((t) => t.id === 1)!;
  return withI18n(createElement(BoardDetailView, { task, board, running, mesh: "demo", store, apply: () => {}, onBack: () => {} }));
}

test("detail view running mesh shows gated controls (status/priority/deps/subtask/comment selects+inputs)", () => {
  const html = renderDetail(sampleBoard(), true, noopStore);
  expect(html).toContain('title="status"');
  expect(html).toContain('title="priority"');
  expect(html).toContain('title="subtask status"');
  expect(html).toContain("board-input"); // deps + add-subtask + comment inputs
  // assignee remains display-only — no assignee select even in the detail
  expect(html).not.toContain('title="assignee"');
});

test("detail view on a stopped mesh is read-only (no selects/inputs, status as pill)", () => {
  const html = renderDetail(sampleBoard(), false, noopStore);
  expect(html).not.toContain("<select");
  expect(html).not.toContain("board-input");
  expect(html).toContain("st-in_progress"); // status pill
});

test("detail renders subtask checklist and comment thread", () => {
  const html = renderDetail(sampleBoard(), true, noopStore);
  expect(html).toContain("subtask A");
  expect(html).toContain("note"); // the comment text
});

test("linked-mail timeline resolves ids against the buffer and degrades to a bare id otherwise", () => {
  const board = sampleBoardWithMail();
  const store = makeStore([{ id: "evt-2", ts: "t", from: "router", to: "alice", body: "dispatch brief body" }]);
  const html = renderDetail(board, true, store);
  expect(html).toContain("router → alice"); // resolved evt-2
  expect(html).toContain("dispatch brief body");
  expect(html).toContain("evt-1"); // dispatch mail id not in buffer → shown raw
});

test("close gate surfaces soft-acceptance reasons and never appears terminal-closed", () => {
  // #1 has an open subtask, a blocking dep (#2 todo), and no integration_ready → all three reasons.
  const html = renderDetail(sampleBoard(), true, noopStore);
  expect(html).toContain("board-close-gate");
  expect(html).toContain("open subtasks");
  expect(html).toContain("incomplete dependencies");
  expect(html).toContain("integration_ready");
  expect(html).toContain("close anyway"); // not ready → "close anyway…" label
});

// ── empties / null safety ─────────────────────────────────────────────────────
test("empty board on a stopped mesh shows the empty state; null board does not crash", () => {
  expect(renderPanel(createEmptyBoard("demo"), false)).toContain("board is empty");
  expect(renderPanel(null, false)).toContain("board is empty");
});

// ── deps helpers (unchanged) ──────────────────────────────────────────────────
test("parseDepsInput dedupes and keeps only positive integers", () => {
  expect(parseDepsInput("1, 2  3")).toEqual([1, 2, 3]);
  expect(parseDepsInput("2,2,2")).toEqual([2]);
  expect(parseDepsInput("x, -1, 0, 4")).toEqual([4]);
  expect(parseDepsInput("")).toEqual([]);
});

test("depsCommit returns null when the value matches current deps (no stale overwrite)", () => {
  expect(depsCommit("2", [2])).toBeNull();
  expect(depsCommit("2,3", [3, 2])).toBeNull();
  expect(depsCommit("2,3", [2])).toEqual([2, 3]);
  expect(depsCommit("", [2])).toEqual([]);
});
