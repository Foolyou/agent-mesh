// Step 7.2-A — focused SSR tests for the /bnw Board C views (list/kanban/detail) + C4 filter
// shell, against a fixture BoardDocument (no store/WS). Asserts real board fields render, the
// GH-Issues filter shell, client-side filtering, group-by-epic, kanban columns, and detail.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BnwBoard } from "./board";
import type { GatewayState, PerMeshState, MeshSummary } from "../../types";
import type { BoardDocument } from "../../../board";
import type { BoardView, BoardFilters } from "../router";
import type { Store } from "../store";

const t = (id: number, o: Partial<BoardDocument["tasks"][number]> = {}): BoardDocument["tasks"][number] => ({
  id, title: `task ${id}`, status: "todo", priority: "normal", deps: [], subtasks: [], subtaskSeq: 0,
  revision: 1, createdBy: "router", createdAt: "", updatedAt: "", comments: [], mailEventIds: [], ...o,
});
const BOARD: BoardDocument = {
  mesh: "demo", revision: 3, epicSeq: 1, taskSeq: 12, labelSeq: 2,
  epics: [{ id: "epic-1", seq: 1, title: "Onboarding", status: "in_progress", revision: 1, createdBy: "router", createdAt: "", updatedAt: "", comments: [] }],
  labels: [{ id: "label-1", name: "ui", color: "#bae6fd" }, { id: "label-2", name: "auth", color: "#e9d5ff" }],
  tasks: [
    t(12, { epicId: "epic-1", title: "Add device-auth page", status: "in_review", assignee: "codex-1", priority: "high", labelIds: ["label-1", "label-2"], subtasks: [{ id: "12.1", title: "gate", status: "done", revision: 1, createdBy: "x", createdAt: "", updatedAt: "", comments: [] }], lifecycleEvents: [{ kind: "dispatched", by: "router", at: "" }], comments: [{ author: "router", text: "dispatched to codex-1", ts: "" }] }),
    t(9, { epicId: "epic-1", title: "Token contrast audit", status: "todo", assignee: "claude-1", deps: [12], labelIds: ["label-1"] }),
    t(5, { title: "Drop legacy theme", status: "done", priority: "low" }),
  ],
};
function pm(board: BoardDocument | null): PerMeshState {
  return { config: { name: "demo", agents: [], edges: [] }, transcripts: {}, activity: [], mail: [], pending: [], history: [], modes: {}, models: {}, efforts: {}, capabilities: {}, usage: {}, health: {}, selfAwareness: {}, queues: {}, board };
}
const SUMMARY: MeshSummary = { name: "demo", defined: true, status: "running", router: "router", agents: [], edges: [] };
function state(board: BoardDocument | null = BOARD): GatewayState {
  return { meshes: [SUMMARY], assistant: { status: "absent", transcript: [] }, perMesh: { demo: pm(board) } };
}
const STUB = { ensureBoardLoaded: async () => {} } as unknown as Store;
const r = (view: BoardView, filters: BoardFilters = {}, issue?: number) => ({ view, filters, issue });

test("board list: rows + C4 filter shell (search / 筛选▾ / view switch / 新建)", () => {
  const out = renderToStaticMarkup(<BnwBoard store={STUB} state={state()} mesh="demo" route={r("list")} />);
  expect(out).toContain("data-bnw-board-list");
  expect(out).toContain("#12");
  expect(out).toContain("Add device-auth page");
  expect(out).toContain("data-bnw-board-filters");
  expect(out).toContain('aria-label="search issues"');
  expect(out).toContain("data-bnw-filter-toggle");
  expect(out).toContain('aria-label="Board view"');
  expect(out).toContain('aria-label="sort"');
  expect(out).toContain("+ 新建");
  expect(out).toContain('aria-label="blocked"'); // #9 dep #12 still open
});

test("board list: status=open filter excludes terminal issues", () => {
  const out = renderToStaticMarkup(<BnwBoard store={STUB} state={state()} mesh="demo" route={r("list", { status: "open" })} />);
  expect(out).toContain("Add device-auth page"); // in_review = open
  expect(out).not.toContain("Drop legacy theme"); // done = excluded
  expect(out).toContain("data-bnw-chip"); // applied-filter chip
  expect(out).toContain('aria-label="remove filter status"');
});

test("board list: group-by-epic", () => {
  const out = renderToStaticMarkup(<BnwBoard store={STUB} state={state()} mesh="demo" route={r("list", { group: "epic" })} />);
  expect(out).toContain("Epic: Onboarding");
});

test("board kanban: status columns + cards", () => {
  const out = renderToStaticMarkup(<BnwBoard store={STUB} state={state()} mesh="demo" route={r("kanban")} />);
  expect(out).toContain("data-bnw-board-kanban");
  for (const col of ["todo", "in_progress", "in_review", "done", "cancelled"]) expect(out).toContain(col);
  expect(out).toContain("#12");
});

test("board detail: meta + subtasks + lifecycle + comments + 7.2-B real mutation controls", () => {
  const out = renderToStaticMarkup(<BnwBoard store={STUB} state={state()} mesh="demo" route={r("list", {}, 12)} />);
  expect(out).toContain("data-bnw-board-detail");
  expect(out).toContain("Add device-auth page");
  expect(out).toContain("gate"); // subtask
  expect(out).toContain("dispatched"); // lifecycle + comment
  expect(out).toContain('aria-label="task status"');     // set_task_status
  expect(out).toContain('aria-label="task priority"');   // set_task_priority
  expect(out).toContain('aria-label="task assignee"');   // assign_task
  expect(out).toContain('aria-label="dispatch task"');   // dispatch_task
  expect(out).toContain('aria-label="comment input"');   // add_comment
  expect(out).toContain('aria-label="close done"');      // set_task_status done
  expect(out.includes("接线于 7.2-B")).toBe(false);
});

test("board detail: terminal issue shows reopen (record_lifecycle_event)", () => {
  const out = renderToStaticMarkup(<BnwBoard store={STUB} state={state()} mesh="demo" route={r("list", {}, 5)} />); // #5 done
  expect(out).toContain('aria-label="reopen issue"');
  expect(out.includes('aria-label="close done"')).toBe(false);
});

test("board 7.2-B: create row + manage-labels + fullscreen affordances in the toolbar", () => {
  const out = renderToStaticMarkup(<BnwBoard store={STUB} state={state()} mesh="demo" route={r("list")} />);
  expect(out).toContain('aria-label="manage labels"');
  expect(out).toContain('aria-label="new issue"');
  expect(out).toContain('aria-label="fullscreen"');
});

test("board 7.2-B: kanban cards draggable + columns are drop targets (→ set_task_status)", () => {
  const out = renderToStaticMarkup(<BnwBoard store={STUB} state={state()} mesh="demo" route={r("kanban")} />);
  expect(out).toContain("data-bnw-card");
  expect(out).toContain('draggable="true"');
  expect(out).toContain('data-bnw-kanban-col="in_review"');
});

test("board 7.2-B: row links preserve the active filter query (GH-style context)", () => {
  const out = renderToStaticMarkup(<BnwBoard store={STUB} state={state()} mesh="demo" route={r("list", { status: "open", label: "ui" })} />);
  expect(out).toMatch(/href="\/bnw\/mesh\/demo\/board\/issue\/\d+\?[^"]*status=open[^"]*label=ui/);
});

test("board detail: unknown issue → not-found", () => {
  const out = renderToStaticMarkup(<BnwBoard store={STUB} state={state()} mesh="demo" route={r("list", {}, 999)} />);
  expect(out).toContain("issue 不存在");
});

test("board: no snapshot yet → loading state", () => {
  const out = renderToStaticMarkup(<BnwBoard store={STUB} state={state(null)} mesh="demo" route={r("list")} />);
  expect(out).toContain("看板载入中");
});
