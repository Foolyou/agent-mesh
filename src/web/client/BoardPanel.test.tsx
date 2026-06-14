import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPanel } from "./BoardPanel";
import { I18nContext, translate } from "./i18n";
import { applyBoardCommand, createEmptyBoard, type BoardDocument, type BoardState } from "../../board";
import type { Store } from "./store";

const noopStore = { boardCommand: async () => ({ board: createEmptyBoard("m"), change: {} }), getBoard: async () => createEmptyBoard("m") } as unknown as Store;

/** Build a small board (epic E1 + task #1 with a subtask, comment, mail link, dep #2). */
function sampleBoard(): BoardDocument {
  const ctx = (s: BoardState) => ({ actor: { kind: "router" as const, agentId: "lead" }, now: "2026-06-15T00:00:00.000Z", expectedBoardRevision: s.revision });
  let s: BoardState = createEmptyBoard("demo");
  const step = (cmd: Parameters<typeof applyBoardCommand>[1]) => {
    const r = applyBoardCommand(s, cmd, ctx(s));
    if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
    s = r.state;
  };
  step({ type: "create_epic", title: "Launch" }); // epic-1
  step({ type: "create_task", title: "Wire it up", epicId: "epic-1" }); // #1
  step({ type: "create_task", title: "Dependency" }); // #2 (no epic)
  // give #1 a subtask, a comment, and a dep on #2
  step({ type: "create_subtask", taskId: 1, expectedRevision: s.tasks.find((t) => t.id === 1)!.revision, title: "subtask A" });
  step({ type: "add_comment", target: { kind: "task", id: 1 }, expectedRevision: s.tasks.find((t) => t.id === 1)!.revision, text: "note" });
  step({ type: "set_task_deps", id: 1, expectedRevision: s.tasks.find((t) => t.id === 1)!.revision, deps: [2] });
  return s;
}

function render(board: BoardDocument | null, running: boolean): string {
  return renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { lang: "en", t: (key, vars) => translate(key, "en", vars) } },
      createElement(BoardPanel, { mesh: "demo", board, running, agents: ["router", "alice"], store: noopStore }),
    ),
  );
}

test("renders the epic/task hierarchy with ids, progress, and counts", () => {
  const html = render(sampleBoard(), true);
  expect(html).toContain("E1"); // epic display id
  expect(html).toContain("Launch");
  expect(html).toContain("#1");
  expect(html).toContain("Wire it up");
  expect(html).toContain("#2");
  expect(html).toContain("rev "); // board revision shown for CAS context
  expect(html).toContain("0/1"); // task #1 subtask progress
});

test("running mesh renders editable controls (status/priority/assignee selects + create inputs)", () => {
  const html = render(sampleBoard(), true);
  expect(html).toContain("<select"); // editable status/priority/assignee
  expect(html).toContain("board-input"); // create-task / create-epic inputs
  expect(html).toContain("board-create");
});

test("stopped mesh is read-only: no selects/inputs, statuses shown as pills", () => {
  const html = render(sampleBoard(), false);
  expect(html).not.toContain("<select");
  expect(html).not.toContain("board-input");
  expect(html).toContain("pill"); // status rendered read-only
  expect(html).toContain("Wire it up");
});

test("surfaces dependency warnings folded from the board", () => {
  // #1 depends on #2 (not done) — computeBoardWarnings flags blocked-by-incomplete once #1 is active.
  const ctx = (s: BoardState) => ({ actor: { kind: "router" as const, agentId: "lead" }, now: "2026-06-15T00:00:00.000Z", expectedBoardRevision: s.revision });
  let s = sampleBoard();
  const r = applyBoardCommand(s, { type: "set_task_status", id: 1, expectedRevision: s.tasks.find((t) => t.id === 1)!.revision, status: "in_progress" }, ctx(s));
  if (r.ok) s = r.state;
  const html = render(s, true);
  expect(html).toContain("⚠");
});

test("empty board on a stopped mesh shows the empty state", () => {
  const html = render(createEmptyBoard("demo"), false);
  expect(html).toContain("board is empty");
});

test("a null board does not crash and shows the empty state when stopped", () => {
  const html = render(null, false);
  expect(html).toContain("board is empty");
});
