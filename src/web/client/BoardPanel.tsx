// Per-mesh collaboration board (Phase 2): a semi-independent list + detail workspace folded
// from board_snapshot. A view switch (List · Board[kanban, Phase 3 placeholder]) with a filter
// bar; clicking an issue opens its detail. In-panel route state {view, issue} is persisted to
// the URL query (parse/serialize below, mirroring FileViewer's parseFileRoute style) so a deep
// link to ?issue=N reopens the detail once the board panel is active. No deltas — the whole
// board arrives on every change, so the views are a pure function of `board`. Running meshes are
// editable through the REST/daemon path (gated by §4 of docs/design/issue-panel.md); a stopped
// mesh renders read-only.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useStore, type Store } from "./store";
import type { MailEntry } from "../types";
import type { BoardDocument, BoardCommand, BoardStatus, BoardPriority, Task } from "../../board";
import { BOARD_STATUSES, BOARD_PRIORITIES, computeBoardWarnings, computeCloseReadiness, epicDisplayId, taskDisplayId, taskProgress } from "../../board";
import { Empty } from "./ui";
import { Markdown } from "./Markdown";
import { useI18n } from "./i18n";

// ── in-panel route (URL query) ───────────────────────────────────────────────
export interface BoardRoute {
  view: "list" | "detail";
  issue?: number;
}

/** Parse the in-panel route from a URL query string (`?board=list|detail&issue=N`). A valid
 *  `issue` implies detail; anything else is the list. Mirrors FileViewer.parseFileRoute, but
 *  query-based so it stays under the mesh without a new top-level app route. */
export function parseBoardRoute(search: string): BoardRoute {
  const p = new URLSearchParams(search);
  const raw = p.get("issue");
  const issue = raw ? Number(raw) : NaN;
  if (Number.isInteger(issue) && issue > 0) return { view: "detail", issue };
  return { view: "list" };
}

/** Serialize the route back into a query string, PRESERVING any other params already on the URL
 *  (detail → `board=detail&issue=N`; list → both keys removed for a clean URL). */
export function serializeBoardRoute(route: BoardRoute, currentSearch: string): string {
  const p = new URLSearchParams(currentSearch);
  if (route.view === "detail" && route.issue && route.issue > 0) {
    p.set("board", "detail");
    p.set("issue", String(route.issue));
  } else {
    p.delete("board");
    p.delete("issue");
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

function safeSearch(): string {
  return typeof window !== "undefined" ? window.location.search : "";
}

// ── filter / sort ─────────────────────────────────────────────────────────────
export type BoardSort = "updated" | "priority" | "id";
export interface BoardFilter {
  status: BoardStatus | "";
  assignee: string; // "" = all, "@unassigned" = no assignee, else exact id
  epic: string; // "" = all, "@none" = no epic, else epic id
  text: string;
  sort: BoardSort;
}
export const EMPTY_FILTER: BoardFilter = { status: "", assignee: "", epic: "", text: "", sort: "updated" };

const PRIORITY_RANK: Record<BoardPriority, number> = { urgent: 3, high: 2, normal: 1, low: 0 };

/** Pure: apply the filter bar's predicates then sort. Exported for unit tests. */
export function filterSortTasks(tasks: Task[], f: BoardFilter): Task[] {
  let out = tasks;
  if (f.status) out = out.filter((t) => t.status === f.status);
  if (f.assignee) out = f.assignee === "@unassigned" ? out.filter((t) => !t.assignee) : out.filter((t) => t.assignee === f.assignee);
  if (f.epic) out = f.epic === "@none" ? out.filter((t) => !t.epicId) : out.filter((t) => t.epicId === f.epic);
  const q = f.text.trim().toLowerCase();
  if (q) out = out.filter((t) => t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q) || `#${t.id}`.includes(q));
  const sorted = [...out];
  if (f.sort === "priority") sorted.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.id - b.id);
  else if (f.sort === "id") sorted.sort((a, b) => a.id - b.id);
  else sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id); // updated, newest first
  return sorted;
}

/** Task ids the advisory DAG warnings mark as blocked (incomplete/missing dep, or in a cycle). */
export function blockedTaskIds(board: BoardDocument): Set<number> {
  const ids = new Set<number>();
  for (const w of computeBoardWarnings(board)) {
    if (w.kind === "blocked_by_incomplete" || w.kind === "missing_dependency") ids.add(w.taskId);
    else if (w.kind === "dependency_cycle") w.taskIds.forEach((id) => ids.add(id));
  }
  return ids;
}

/** Compact, locale-independent timestamp ("06-15 00:00" from an ISO string) for list rows. */
function shortTime(iso: string): string {
  return iso.length >= 16 ? iso.slice(5, 16).replace("T", " ") : iso;
}

// ── panel shell ───────────────────────────────────────────────────────────────
export function BoardPanel({
  mesh,
  board,
  running,
  agents,
  store,
  className,
  style,
  initialRoute,
}: {
  mesh: string;
  board: BoardDocument | null;
  running: boolean;
  agents: string[];
  store: Store;
  className?: string;
  style?: CSSProperties;
  /** Test/deep-control seam: when omitted, the route is read from the URL query. */
  initialRoute?: BoardRoute;
}) {
  const { t } = useI18n();
  const [route, setRoute] = useState<BoardRoute>(() => initialRoute ?? parseBoardRoute(safeSearch()));
  const [filter, setFilter] = useState<BoardFilter>(EMPTY_FILTER);
  const [groupByEpic, setGroupByEpic] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Fetch the durable board once when the folded copy is null (fresh load or a stopped mesh).
  useEffect(() => {
    if (!board) void store.ensureBoardLoaded(mesh);
  }, [mesh, board, store]);

  // Keep the in-panel route in sync with browser back/forward (its own listener; coexists with
  // the App-level path route, which this never touches).
  useEffect(() => {
    const onPop = () => setRoute(parseBoardRoute(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = (next: BoardRoute, push: boolean) => {
    if (typeof window !== "undefined") {
      const url = window.location.pathname + serializeBoardRoute(next, window.location.search) + window.location.hash;
      if (push) window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    }
    setRoute(next);
  };
  const openDetail = (id: number) => navigate({ view: "detail", issue: id }, true); // pushState: Back returns to list
  const backToList = () => {
    if (typeof window !== "undefined" && window.history.length > 1) window.history.back();
    else navigate({ view: "list" }, false);
  };

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
  const selected = route.view === "detail" && route.issue != null ? board.tasks.find((task) => task.id === route.issue) : undefined;
  const showDetail = route.view === "detail" && selected;

  return (
    <div className={`board ${fullscreen ? "board-fs" : ""} ${className ?? ""}`} style={style}>
      <div className="board-head">
        <div className="board-views" role="tablist" aria-label="board views">
          <button className={`seg-tab ${route.view === "list" ? "sel" : ""}`} role="tab" aria-selected={route.view === "list"} onClick={() => navigate({ view: "list" }, false)}>
            {t("board.viewList")}
          </button>
          <button className="seg-tab" role="tab" aria-selected={false} disabled title={t("board.viewBoardSoon")}>
            {t("board.viewBoard")}
          </button>
        </div>
        <span className="sub">rev {board.revision}</span>
        {warnings.length > 0 && (
          <span className="board-warn" title={warnings.map((w) => w.message).join("\n")}>
            ⚠ {warnings.length}
          </span>
        )}
        <button className="board-fs-btn" onClick={() => setFullscreen((v) => !v)} aria-pressed={fullscreen} title={t("board.fullscreen")}>
          {fullscreen ? "🗕" : "🗖"}
        </button>
        {running && !showDetail && <CreateRow apply={apply} />}
      </div>
      {showDetail ? (
        <BoardDetailView task={selected} board={board} running={running} mesh={mesh} store={store} apply={apply} onBack={backToList} />
      ) : (
        <>
          <FilterBar board={board} filter={filter} setFilter={setFilter} groupByEpic={groupByEpic} setGroupByEpic={setGroupByEpic} />
          <BoardListView board={board} filter={filter} groupByEpic={groupByEpic} onOpen={openDetail} />
        </>
      )}
    </div>
  );
}

// ── filter bar ────────────────────────────────────────────────────────────────
function FilterBar({
  board,
  filter,
  setFilter,
  groupByEpic,
  setGroupByEpic,
}: {
  board: BoardDocument;
  filter: BoardFilter;
  setFilter: (f: BoardFilter) => void;
  groupByEpic: boolean;
  setGroupByEpic: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const assignees = useMemo(() => [...new Set(board.tasks.map((task) => task.assignee).filter((a): a is string => !!a))].sort(), [board.tasks]);
  return (
    <div className="board-filter">
      <input
        className="board-input board-filter-text"
        placeholder={t("board.filterText")}
        aria-label={t("board.filterText")}
        value={filter.text}
        onChange={(e) => setFilter({ ...filter, text: e.target.value })}
      />
      <select className="select-control board-sel" aria-label={t("board.filterStatus")} value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value as BoardStatus | "" })}>
        <option value="">{t("board.allStatus")}</option>
        {BOARD_STATUSES.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <select className="select-control board-sel" aria-label={t("board.filterAssignee")} value={filter.assignee} onChange={(e) => setFilter({ ...filter, assignee: e.target.value })}>
        <option value="">{t("board.allAssignees")}</option>
        <option value="@unassigned">{t("board.unassigned")}</option>
        {assignees.map((a) => (
          <option key={a} value={a}>{a}</option>
        ))}
      </select>
      <select className="select-control board-sel" aria-label={t("board.filterEpic")} value={filter.epic} onChange={(e) => setFilter({ ...filter, epic: e.target.value })}>
        <option value="">{t("board.allEpics")}</option>
        <option value="@none">{t("board.noEpic")}</option>
        {board.epics.map((epic) => (
          <option key={epic.id} value={epic.id}>{epicDisplayId(epic)} {epic.title}</option>
        ))}
      </select>
      <select className="select-control board-sel" aria-label={t("board.sort")} value={filter.sort} onChange={(e) => setFilter({ ...filter, sort: e.target.value as BoardSort })}>
        <option value="updated">{t("board.sortUpdated")}</option>
        <option value="priority">{t("board.sortPriority")}</option>
        <option value="id">{t("board.sortId")}</option>
      </select>
      <label className="board-group-toggle sub">
        <input type="checkbox" checked={groupByEpic} onChange={(e) => setGroupByEpic(e.target.checked)} />
        {t("board.groupByEpic")}
      </label>
    </div>
  );
}

// ── list view ─────────────────────────────────────────────────────────────────
export function BoardListView({
  board,
  filter,
  groupByEpic,
  onOpen,
}: {
  board: BoardDocument;
  filter: BoardFilter;
  groupByEpic: boolean;
  onOpen: (id: number) => void;
}) {
  const { t } = useI18n();
  const blocked = useMemo(() => blockedTaskIds(board), [board]);
  const tasks = useMemo(() => filterSortTasks(board.tasks, filter), [board.tasks, filter]);

  if (tasks.length === 0) return <div className="board-list"><Empty>{t("board.noMatches")}</Empty></div>;

  if (!groupByEpic) {
    return (
      <div className="board-list">
        {tasks.map((task) => (
          <IssueRow key={task.id} task={task} blocked={blocked.has(task.id)} onOpen={onOpen} />
        ))}
      </div>
    );
  }

  // group-by-epic: epics in board order, then an "orphan" bucket; only non-empty groups render.
  const groups: { key: string; label: string; tasks: Task[] }[] = board.epics.map((epic) => ({
    key: epic.id,
    label: `${epicDisplayId(epic)} ${epic.title}`,
    tasks: tasks.filter((task) => task.epicId === epic.id),
  }));
  const orphans = tasks.filter((task) => !task.epicId);
  if (orphans.length) groups.push({ key: "@none", label: t("board.noEpic"), tasks: orphans });

  return (
    <div className="board-list">
      {groups.filter((g) => g.tasks.length > 0).map((g) => (
        <div className="board-group" key={g.key}>
          <div className="board-group-head sub">{g.label}</div>
          {g.tasks.map((task) => (
            <IssueRow key={task.id} task={task} blocked={blocked.has(task.id)} onOpen={onOpen} />
          ))}
        </div>
      ))}
    </div>
  );
}

function IssueRow({ task, blocked, onOpen }: { task: Task; blocked: boolean; onOpen: (id: number) => void }) {
  const prog = taskProgress(task);
  return (
    <button className="board-issue" onClick={() => onOpen(task.id)}>
      <span className="board-tid">{taskDisplayId(task.id)}</span>
      <span className="board-title">{task.title}</span>
      <span className={`pill st-${task.status}`}>{task.status}</span>
      {/* assignee is DISPLAY-ONLY in the panel (§4: humans ask the router to assign). */}
      {task.assignee && <span className="sub board-assignee">@{task.assignee}</span>}
      <span className="sub board-prio">{task.priority}</span>
      <span className="board-meta">
        {prog.total > 0 && <span className="sub" title="subtasks done">{prog.done}/{prog.total}</span>}
        {blocked && <span className="pill board-blocked" title="blocked by an incomplete dependency">blocked</span>}
        {task.dispatch?.mailFailed && <span className="sub board-mailfail" title="dispatch mail failed">✉⚠</span>}
        {task.closeReady && <span className="sub board-closeready" title="integration-ready (close-ready)">✔ready</span>}
        <span className="sub board-updated" title={task.updatedAt}>{shortTime(task.updatedAt)}</span>
      </span>
    </button>
  );
}

// ── detail view ─────────────────────────────────────────────────────────────
//  Read for everyone; editable controls (status/priority/deps, subtasks, comments, close) are
//  gated by `running` + the reducer's §4 permissions. Assignee stays DISPLAY-ONLY (humans ask the
//  router to assign). The linked-mail timeline resolves mailEventIds/dispatch against the live
//  recent-mail buffer and degrades to bare ids when a mail isn't in the buffer.
export function BoardDetailView({
  task,
  board,
  running,
  mesh,
  store,
  apply,
  onBack,
}: {
  task: Task;
  board: BoardDocument;
  running: boolean;
  mesh: string;
  store: Store;
  apply: (c: BoardCommand) => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [subtitle, setSubtitle] = useState("");
  const [comment, setComment] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);

  const recentMail = useStore(store).perMesh[mesh]?.mail ?? [];
  const mailById = useMemo(() => new Map(recentMail.map((m) => [m.id, m])), [recentMail]);
  const linkedMailIds = useMemo(() => {
    const ids = [...task.mailEventIds];
    if (task.dispatch?.mailEventId && !ids.includes(task.dispatch.mailEventId)) ids.push(task.dispatch.mailEventId);
    return ids;
  }, [task.mailEventIds, task.dispatch?.mailEventId]);

  const close = computeCloseReadiness(board, task.id);
  const terminal = task.status === "done" || task.status === "cancelled";
  const depsKey = task.deps.join(",");
  const commitDeps = (value: string) => {
    const next = depsCommit(value, task.deps);
    if (next) apply({ type: "set_task_deps", id: task.id, expectedRevision: task.revision, deps: next });
  };

  return (
    <div className="board-detail">
      <div className="board-detail-head">
        <button className="board-back" onClick={onBack} aria-label={t("board.back")}>← {t("board.back")}</button>
        <span className="board-tid">{taskDisplayId(task.id)}</span>
        <span className="board-title">{task.title}</span>
        {running ? (
          <select className="select-control board-sel" title="status" value={task.status} onChange={(e) => apply({ type: "set_task_status", id: task.id, expectedRevision: task.revision, status: e.target.value as BoardStatus })}>
            {BOARD_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        ) : (
          <span className={`pill st-${task.status}`}>{task.status}</span>
        )}
      </div>

      <div className="board-detail-meta sub">
        {/* assignee DISPLAY-ONLY (§4): the panel never exposes an assign control. */}
        {task.assignee ? <span>@{task.assignee}</span> : <span>{t("board.unassigned")}</span>}
        {running ? (
          <select className="select-control board-sel" title="priority" value={task.priority} onChange={(e) => apply({ type: "set_task_priority", id: task.id, expectedRevision: task.revision, priority: e.target.value as BoardPriority })}>
            {BOARD_PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        ) : (
          <span> · {task.priority}</span>
        )}
        {task.taskSlug && <span> · <code>{task.taskSlug}</code></span>}
        {task.branchName && <span> · <code>{task.branchName}</code></span>}
      </div>

      {task.description && (
        <div className="board-detail-desc">
          <Markdown text={task.description} />
        </div>
      )}

      {/* dependencies (gated edit, re-keyed uncontrolled input like the list-less Phase 1 row) */}
      {running ? (
        <div className="board-row">
          <span className="sub">{t("board.deps")}</span>
          <input
            key={`deps-${task.id}-${depsKey}`}
            className="board-input"
            placeholder={t("board.depsPlaceholder")}
            defaultValue={depsKey}
            onBlur={(e) => commitDeps(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitDeps((e.target as HTMLInputElement).value); }}
          />
        </div>
      ) : (
        task.deps.length > 0 && <div className="sub">{t("board.deps")} {task.deps.map((d) => `#${d}`).join(", ")}</div>
      )}

      {/* subtask checklist */}
      <div className="board-detail-section">
        <div className="board-section-head sub">{t("board.subtasks")} {task.subtasks.length > 0 && <>· {taskProgress(task).done}/{taskProgress(task).total}</>}</div>
        {task.subtasks.map((sub) => (
          <div className="board-subtask" key={sub.id}>
            <span className="board-tid">{sub.id}</span>
            <span className="board-title">{sub.title}</span>
            {running ? (
              <select className="select-control board-sel" title="subtask status" value={sub.status} onChange={(e) => apply({ type: "set_subtask_status", taskId: task.id, subtaskId: sub.id, expectedRevision: sub.revision, status: e.target.value as BoardStatus })}>
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
        )}
      </div>

      {/* lifecycle timeline */}
      {(task.lifecycleEvents?.length ?? 0) > 0 && (
        <div className="board-detail-section">
          <div className="board-section-head sub">{t("board.lifecycle")}</div>
          <div className="board-timeline" aria-label="lifecycle timeline">
            {task.lifecycleEvents!.map((e, i) => (
              <span className="pill board-lc-pill" key={i} title={`${e.by} · ${e.at}`}>{e.kind}</span>
            ))}
          </div>
        </div>
      )}

      {/* linked-mail timeline (resolve ids against the recent buffer; degrade to bare id) */}
      {linkedMailIds.length > 0 && (
        <div className="board-detail-section">
          <div className="board-section-head sub">{t("board.linkedMail")}</div>
          {linkedMailIds.map((id) => {
            const m = mailById.get(id);
            return (
              <div className="board-mail-row" key={id}>
                {m ? (
                  <>
                    <span className="sub">{m.from} → {m.to}</span>
                    <span className="board-ctext">{m.body.length > 80 ? `${m.body.slice(0, 80)}…` : m.body}</span>
                  </>
                ) : (
                  <span className="sub board-mail-unresolved" title="mail not in the recent buffer">✉ {id}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* comment thread */}
      <div className="board-detail-section">
        <div className="board-section-head sub">{t("board.comments")} {task.comments.length > 0 && <>· {task.comments.length}</>}</div>
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

      {/* close action with a SOFT acceptance gate (computeCloseReadiness): surfaces reasons,
          never hard-blocks. Operator/router only; reducer enforces the real permission. */}
      {running && !terminal && (
        <div className="board-close-gate">
          {!close.ready && (
            <ul className="board-close-reasons sub">
              {close.openSubtasks > 0 && <li>{t("board.openSubtasks")}: {close.openSubtasks}</li>}
              {close.blockingDeps.length > 0 && <li>{t("board.blockingDeps")}: {close.blockingDeps.map((d) => `#${d}`).join(", ")}</li>}
              {!close.hasIntegrationReady && <li>{t("board.needsIntegration")}</li>}
            </ul>
          )}
          {confirmClose ? (
            <span className="board-close-confirm">
              <button className="board-back" onClick={() => apply({ type: "set_task_status", id: task.id, expectedRevision: task.revision, status: "done" })}>{t("board.confirmClose")}</button>
              <button className="board-back" onClick={() => setConfirmClose(false)}>{t("cancel")}</button>
            </span>
          ) : (
            <button className="board-back" onClick={() => setConfirmClose(true)}>
              {close.ready ? t("board.close") : t("board.closeAnyway")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── create row (router/operator only; running meshes) ───────────────────────────
function CreateRow({ apply }: { apply: (c: BoardCommand) => void }) {
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
    </span>
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
