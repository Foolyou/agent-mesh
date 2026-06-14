// Per-mesh collaboration board (Phase 1): a compact, operator-editable view of the
// Epic → Task → Subtask hierarchy folded from board_snapshot. Running meshes are editable
// through the REST/daemon path; a stopped mesh renders read-only. No deltas — the whole
// board arrives on every change, so this component is a pure function of `board`.
import { useEffect, useState, type CSSProperties } from "react";
import type { Store } from "./store";
import type { BoardDocument, BoardCommand, BoardStatus, Task } from "../../board";
import { BOARD_STATUSES, BOARD_PRIORITIES, computeBoardWarnings, epicDisplayId, epicProgress, taskDisplayId, taskProgress } from "../../board";
import { Empty } from "./ui";
import { useI18n } from "./i18n";

export function BoardPanel({
  mesh,
  board,
  running,
  agents,
  store,
  className,
  style,
}: {
  mesh: string;
  board: BoardDocument | null;
  running: boolean;
  agents: string[];
  store: Store;
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useI18n();
  // Fetch the durable board once when the folded copy is null (fresh page load or a stopped
  // mesh with no daemon pushing board_snapshot). Coalesced + one-shot in the store.
  useEffect(() => {
    if (!board) void store.ensureBoardLoaded(mesh);
  }, [mesh, board, store]);

  const apply = (command: BoardCommand) => {
    if (!running) return;
    void store.boardCommand(mesh, command, board?.revision ?? 0).catch(() => {});
  };

  if (!board || (board.epics.length === 0 && board.tasks.length === 0 && !running)) {
    return (
      <div className={`board ${className ?? ""}`} style={style}>
        <Empty>{t("empty.board")}</Empty>
      </div>
    );
  }

  const warnings = computeBoardWarnings(board);
  const orphanTasks = board.tasks.filter((task) => !task.epicId);

  return (
    <div className={`board ${className ?? ""}`} style={style}>
      <div className="board-head">
        <span className="sub">rev {board.revision}</span>
        {warnings.length > 0 && (
          <span className="board-warn" title={warnings.map((w) => w.message).join("\n")}>
            ⚠ {warnings.length}
          </span>
        )}
        {running && <CreateRow apply={apply} hasEpics />}
      </div>
      <div className="board-body">
        {board.epics.map((epic) => {
          const prog = epicProgress(board, epic.id);
          const tasks = board.tasks.filter((task) => task.epicId === epic.id);
          return (
            <div className="board-epic" key={epic.id}>
              <div className="board-epic-head">
                <span className="board-eid">{epicDisplayId(epic)}</span>
                <span className="board-title">{epic.title}</span>
                <span className={`pill st-${epic.status}`}>{epic.status}</span>
                {prog.total > 0 && <span className="sub">{prog.done}/{prog.total}</span>}
                {running && (
                  <button className="board-x" title="delete epic" onClick={() => apply({ type: "delete_epic", id: epic.id, expectedRevision: epic.revision })}>
                    ×
                  </button>
                )}
              </div>
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} board={board} running={running} agents={agents} apply={apply} />
              ))}
            </div>
          );
        })}
        {orphanTasks.length > 0 && (
          <div className="board-epic">
            <div className="board-epic-head">
              <span className="sub">{t("board.noEpic")}</span>
            </div>
            {orphanTasks.map((task) => (
              <TaskRow key={task.id} task={task} board={board} running={running} agents={agents} apply={apply} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CreateRow({ apply, hasEpics }: { apply: (c: BoardCommand) => void; hasEpics: boolean }) {
  const { t } = useI18n();
  const [task, setTask] = useState("");
  const [epic, setEpic] = useState("");
  return (
    <span className="board-create">
      <input
        className="board-input"
        placeholder={t("board.newTask")}
        value={task}
        onChange={(e) => setTask(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && task.trim()) {
            apply({ type: "create_task", title: task.trim() });
            setTask("");
          }
        }}
      />
      <input
        className="board-input"
        placeholder={t("board.newEpic")}
        value={epic}
        onChange={(e) => setEpic(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && epic.trim()) {
            apply({ type: "create_epic", title: epic.trim() });
            setEpic("");
          }
        }}
      />
      {/* hasEpics is accepted for future epic-target selection; tasks default to no epic */}
      <span hidden>{String(hasEpics)}</span>
    </span>
  );
}

function TaskRow({
  task,
  board,
  running,
  agents,
  apply,
}: {
  task: Task;
  board: BoardDocument;
  running: boolean;
  agents: string[];
  apply: (c: BoardCommand) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [subtitle, setSubtitle] = useState("");
  const [comment, setComment] = useState("");
  const prog = taskProgress(task);
  const depsKey = task.deps.join(",");

  // The deps input is UNCONTROLLED and re-keyed on task.deps, so a full-board snapshot that
  // changes task.deps remounts it with the fresh value — no persistent local state can go
  // stale and overwrite newer deps. commit only fires when the value actually differs.
  const commitDeps = (value: string) => {
    const next = depsCommit(value, task.deps);
    if (next) apply({ type: "set_task_deps", id: task.id, expectedRevision: task.revision, deps: next });
  };

  return (
    <div className="board-task">
      <div className="board-task-head">
        <button className="board-twirl" onClick={() => setOpen((v) => !v)} aria-label="expand task">
          {open ? "▾" : "▸"}
        </button>
        <span className="board-tid">{taskDisplayId(task.id)}</span>
        <span className="board-title">{task.title}</span>
        {running ? (
          <select className="select-control board-sel" value={task.status} onChange={(e) => apply({ type: "set_task_status", id: task.id, expectedRevision: task.revision, status: e.target.value as BoardStatus })}>
            {BOARD_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        ) : (
          <span className={`pill st-${task.status}`}>{task.status}</span>
        )}
        {running ? (
          <select className="select-control board-sel" value={task.priority} title="priority" onChange={(e) => apply({ type: "set_task_priority", id: task.id, expectedRevision: task.revision, priority: e.target.value as Task["priority"] })}>
            {BOARD_PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        ) : (
          <span className="sub">{task.priority}</span>
        )}
        {running ? (
          <select className="select-control board-sel" value={task.assignee ?? ""} title="assignee" onChange={(e) => apply({ type: "assign_task", id: task.id, expectedRevision: task.revision, assignee: e.target.value || undefined })}>
            <option value="">{t("board.unassigned")}</option>
            {agents.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        ) : (
          task.assignee && <span className="sub">@{task.assignee}</span>
        )}
        <span className="board-meta">
          {prog.total > 0 && <span className="sub" title="subtasks done">{prog.done}/{prog.total}</span>}
          {task.comments.length > 0 && <span className="sub" title="comments">💬{task.comments.length}</span>}
          {task.mailEventIds.length > 0 && <span className="sub" title="linked mail">✉{task.mailEventIds.length}</span>}
          {task.deps.length > 0 && <span className="sub" title="dependencies">{t("board.deps")} {task.deps.map((d) => `#${d}`).join(",")}</span>}
        </span>
      </div>
      {open && (
        <div className="board-task-body">
          {task.subtasks.map((sub) => (
            <div className="board-subtask" key={sub.id}>
              <span className="board-tid">{sub.id}</span>
              <span className="board-title">{sub.title}</span>
              {running ? (
                <select className="select-control board-sel" value={sub.status} onChange={(e) => apply({ type: "set_subtask_status", taskId: task.id, subtaskId: sub.id, expectedRevision: sub.revision, status: e.target.value as BoardStatus })}>
                  {BOARD_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              ) : (
                <span className={`pill st-${sub.status}`}>{sub.status}</span>
              )}
            </div>
          ))}
          {running && (
            <div className="board-row">
              <input
                className="board-input"
                placeholder={t("board.addSubtask")}
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && subtitle.trim()) {
                    apply({ type: "create_subtask", taskId: task.id, expectedRevision: task.revision, title: subtitle.trim() });
                    setSubtitle("");
                  }
                }}
              />
              <input
                key={`deps-${task.id}-${depsKey}`}
                className="board-input"
                placeholder={t("board.depsPlaceholder")}
                defaultValue={depsKey}
                onBlur={(e) => commitDeps(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commitDeps((e.target as HTMLInputElement).value); }}
              />
            </div>
          )}
          {task.comments.map((c, i) => (
            <div className="board-comment" key={i}>
              <span className="sub">{c.author}</span>
              <span className="board-ctext">{c.text}</span>
            </div>
          ))}
          {running && (
            <input
              className="board-input"
              placeholder={t("board.comment")}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && comment.trim()) {
                  apply({ type: "add_comment", target: { kind: "task", id: task.id }, expectedRevision: task.revision, text: comment.trim() });
                  setComment("");
                }
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Parse a free-text deps field ("1, 2  3") into a deduped, positive-int task-id list. */
export function parseDepsInput(value: string): number[] {
  return [...new Set(value.split(/[\s,]+/).map((d) => Number(d.trim())).filter((n) => Number.isInteger(n) && n > 0))];
}

/** Decide the deps to commit, or null when the input matches the current deps (skip the
 *  write). Because the input is re-keyed on task.deps, `value` reflects the latest snapshot
 *  unless the user actually edited it — so a stale value never overwrites newer deps. */
export function depsCommit(value: string, current: number[]): number[] | null {
  const next = parseDepsInput(value);
  const cur = [...new Set(current)].sort((a, b) => a - b);
  const nxt = [...next].sort((a, b) => a - b);
  if (cur.length === nxt.length && cur.every((v, i) => v === nxt[i])) return null;
  return next;
}
