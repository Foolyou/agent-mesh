// Step 7.2-A — new /bnw Board C views (list / kanban / detail) + C4 GH-Issues filter shell,
// wired to the REAL store.board (ensureBoardLoaded + board snapshots). Independent view layer:
// shares the store only; does NOT import or modify the old BoardPanel. Mirrors the confirmed
// C4 mockup (/__ui-mockup?surface=board) + coverage/03-board.md.
//
// 7.2-A is READ + filter/nav (filters live in the URL query, the source of truth). Board
// MUTATIONS (set-status, create task/epic, label CRUD+palette, reopen, comment, dispatch,
// fullscreen) land in 7.2-B — surfaced as deferred, never faked.
import { useEffect, useMemo, useState } from "react";
import {
  AssigneeTag, Badge, Button, Cluster, EmptyState, PanelFrame, ProgressBar, RouteLink,
  SegmentedControl, Select, StatusChip, type Status,
} from "../ui/index";
import type { Store } from "../store";
import type { GatewayState } from "../../types";
import type { BoardDocument, BoardStatus, Task, Epic } from "../../../board";
import { bnwHref, navigate, type BoardFilters, type BoardView } from "../router";

const STATUS_ORDER: BoardStatus[] = ["todo", "in_progress", "in_review", "done", "cancelled"];
const PRIO_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function boardDot(s: BoardStatus): Status {
  switch (s) {
    case "in_progress": return "working";
    case "in_review": return "attention";
    case "done": return "done";
    case "cancelled": return "blocked";
    case "todo": default: return "idle";
  }
}
const isOpen = (s: BoardStatus) => s !== "done" && s !== "cancelled";
function labelNames(task: Task, board: BoardDocument): string[] {
  const labels = board.labels ?? [];
  return (task.labelIds ?? []).map((id) => labels.find((l) => l.id === id)?.name).filter((n): n is string => !!n);
}
function blockedBy(task: Task, board: BoardDocument): boolean {
  return (task.deps ?? []).some((d) => { const dep = board.tasks.find((t) => t.id === d); return dep ? isOpen(dep.status) : false; });
}
function subtaskProgress(task: Task): { done: number; total: number } {
  const total = task.subtasks.length;
  return { done: task.subtasks.filter((s) => s.status === "done").length, total };
}

// Apply the C4 filters (status/label/assignee/epic/q) + sort. Pure over the task list.
function applyFilters(tasks: Task[], board: BoardDocument, f: BoardFilters): Task[] {
  let out = tasks.filter((t) => {
    if (f.status === "open" && !isOpen(t.status)) return false;
    if (f.status && f.status !== "open" && t.status !== f.status) return false;
    if (f.label && !labelNames(t, board).includes(f.label)) return false;
    if (f.assignee && t.assignee !== f.assignee) return false;
    if (f.epic && t.epicId !== f.epic) return false;
    if (f.q) { const q = f.q.toLowerCase(); if (!(`#${t.id} ${t.title} ${t.description ?? ""}`.toLowerCase().includes(q))) return false; }
    return true;
  });
  const sort = f.sort ?? "number";
  out = [...out].sort((a, b) => {
    if (sort === "priority") return (PRIO_RANK[a.priority] ?? 9) - (PRIO_RANK[b.priority] ?? 9);
    if (sort === "updated") return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    if (sort === "created") return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    return b.id - a.id; // number (newest first)
  });
  return out;
}

function LabelChip({ name }: { name: string }) {
  return <span className="inline-flex items-center gap-0.5 rounded border border-border bg-surface-sunken px-1.5 py-0.5 text-xs text-text-secondary">🏷 {name}</span>;
}
function PrioTag({ prio }: { prio: string }) {
  const tone = prio === "urgent" || prio === "high" ? "text-danger" : prio === "normal" ? "text-text-muted" : "text-text-muted";
  return <span className={`text-xs font-medium ${tone}`}>{prio}</span>;
}
function SubProgress({ task }: { task: Task }) {
  const { done, total } = subtaskProgress(task);
  if (total === 0) return <span className="text-xs text-text-muted">—</span>;
  return <span className="inline-flex items-center gap-1.5"><span className="w-12"><ProgressBar value={done} max={total} label={`subtasks ${done}/${total}`} /></span><span className="text-xs tabular-nums text-text-muted">{done}/{total}</span></span>;
}

// ── C4 GH-Issues filter shell (nav-driven; filters live in the URL) ───────────
function BoardFilters({ mesh, route, board }: { mesh: string; route: { view: BoardView; filters: BoardFilters }; board: BoardDocument }) {
  const [menu, setMenu] = useState(false);
  const f = route.filters;
  const go = (next: BoardFilters, view: BoardView = route.view) => navigate({ k: "board", mesh, view, filters: next });
  const setF = (patch: Partial<BoardFilters>) => go({ ...f, ...patch });
  const labels = board.labels ?? [];
  const assignees = Array.from(new Set(board.tasks.map((t) => t.assignee).filter((a): a is string => !!a)));
  const applied = (["status", "label", "assignee", "epic", "q"] as const).filter((k) => f[k]).map((k) => ({ k, v: f[k] as string }));
  const viewSwitch = <SegmentedControl ariaLabel="Board view" value={route.view} size="sm"
    onChange={(v) => go(f, v as BoardView)} options={[{ value: "list", label: "List" }, { value: "kanban", label: "Board" }]} />;
  return (
    <div data-bnw-board-filters className="flex flex-col gap-2">
      <div role="toolbar" aria-label="board filters" className="flex items-center gap-2">
        <span className="relative flex min-w-0 flex-1 items-center">
          <span aria-hidden="true" className="pointer-events-none absolute left-2 text-text-muted">🔍</span>
          <input aria-label="search issues" value={f.q ?? ""} placeholder="搜索 issue… 例如 status:open label:bug"
            onChange={(e) => setF({ q: e.target.value || undefined })}
            className="w-full min-w-0 rounded-lg border border-border-strong bg-surface-sunken py-1 pl-7 pr-2 text-sm text-text-primary placeholder:text-text-muted" />
        </span>
        <button type="button" data-bnw-filter-toggle aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}
          className="shrink-0 rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-xs text-text-primary hover:bg-hover">{menu ? "▾ 筛选" : "筛选 ▾"}</button>
        <span className="shrink-0"><Cluster>
          {viewSwitch}
          <Select aria-label="sort" value={f.sort ?? "number"} onChange={(e) => setF({ sort: e.target.value })} className="w-24"><option value="number">number</option><option value="updated">updated</option><option value="created">created</option><option value="priority">priority</option></Select>
          <Button size="sm" variant="primary" disabled aria-label="new issue" title="新建 / 管理标签 / 全屏 接线于 7.2-B">+ 新建</Button>
        </Cluster></span>
      </div>
      {menu ? (
        <div role="menu" data-bnw-filter-menu className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-raised p-2">
          <Select aria-label="status filter" value={f.status ?? ""} onChange={(e) => setF({ status: e.target.value || undefined })} className="w-32"><option value="">status: any</option><option value="open">open</option>{STATUS_ORDER.map((s) => <option key={s} value={s}>{s}</option>)}</Select>
          <Select aria-label="label filter" value={f.label ?? ""} onChange={(e) => setF({ label: e.target.value || undefined })} className="w-32"><option value="">label: any</option>{labels.map((l) => <option key={l.id} value={l.name}>{l.name}</option>)}</Select>
          <Select aria-label="assignee filter" value={f.assignee ?? ""} onChange={(e) => setF({ assignee: e.target.value || undefined })} className="w-32"><option value="">assignee: any</option>{assignees.map((a) => <option key={a} value={a}>{a}</option>)}</Select>
          <Select aria-label="epic filter" value={f.epic ?? ""} onChange={(e) => setF({ epic: e.target.value || undefined })} className="w-36"><option value="">epic: any</option>{board.epics.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</Select>
          <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary"><input type="checkbox" aria-label="group by epic" checked={f.group === "epic"} onChange={(e) => setF({ group: e.target.checked ? "epic" : undefined })} className="accent-accent" /> 按 Epic 分组</label>
          <span className="text-xs text-text-muted">管理标签 / 全屏 接线于 7.2-B</span>
        </div>
      ) : null}
      {applied.length ? (
        <div data-bnw-board-chips className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-text-muted">已筛选</span>
          {applied.map((a) => (
            <span key={a.k} data-bnw-chip className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-xs text-text-secondary">
              {a.k}:{a.v}
              <button type="button" aria-label={`remove filter ${a.k}`} onClick={() => setF({ [a.k]: undefined } as Partial<BoardFilters>)} className="rounded-full px-0.5 text-text-muted hover:text-text-primary">×</button>
            </span>
          ))}
          <button type="button" aria-label="clear all filters" onClick={() => go({ sort: f.sort })} className="ml-1 text-xs text-accent hover:underline">清除全部</button>
        </div>
      ) : null}
    </div>
  );
}

// ── list ──────────────────────────────────────────────────────────────────────
function IssueRow({ mesh, task, board }: { mesh: string; task: Task; board: BoardDocument }) {
  const names = labelNames(task, board);
  const { done, total } = subtaskProgress(task);
  return (
    <RouteLink href={bnwHref({ k: "board", mesh, view: "list", issue: task.id, filters: {} })} unstyled
      className="flex items-center gap-2.5 border-b border-border px-3 py-2 hover:bg-hover">
      <StatusChip status={boardDot(task.status)} variant="dot" />
      <span className="w-9 shrink-0 text-xs tabular-nums text-text-muted">#{task.id}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{task.title}</span>
      {blockedBy(task, board) ? <span className="text-danger" title="blocked" aria-label="blocked">⛔</span> : null}
      <span className="hidden items-center gap-1 lg:flex">{names.map((n) => <LabelChip key={n} name={n} />)}</span>
      <AssigneeTag name={task.assignee || "—"} size="sm" iconOnly />
      <PrioTag prio={task.priority} />
      {total ? <SubProgress task={task} /> : null}
    </RouteLink>
  );
}
function ListView({ mesh, board, route }: { mesh: string; board: BoardDocument; route: { view: BoardView; filters: BoardFilters } }) {
  const tasks = applyFilters(board.tasks, board, route.filters);
  const open = tasks.filter((t) => isOpen(t.status)).length;
  if (tasks.length === 0) return <EmptyState title="无匹配 issue" description="调整筛选或清除条件。" />;
  if (route.filters.group === "epic") {
    const groups: { epic: Epic | null; items: Task[] }[] = [
      ...board.epics.map((e) => ({ epic: e, items: tasks.filter((t) => t.epicId === e.id) })),
      { epic: null, items: tasks.filter((t) => !t.epicId) },
    ].filter((g) => g.items.length);
    return (
      <div data-bnw-board-list className="flex flex-col gap-2">
        <div className="px-1 text-xs text-text-muted tabular-nums">{open} open · {tasks.length - open} closed</div>
        {groups.map((g) => (
          <div key={g.epic?.id ?? "no-epic"} className="flex flex-col">
            <div className="flex items-center gap-2 rounded-lg bg-surface-sunken px-3 py-1.5"><span aria-hidden="true" className="text-text-muted">▾</span><span className="text-sm font-medium text-text-primary">Epic: {g.epic?.title ?? "（无 epic）"}</span><span className="text-xs text-text-muted">({g.items.length})</span></div>
            {g.items.map((t) => <IssueRow key={t.id} mesh={mesh} task={t} board={board} />)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div data-bnw-board-list className="flex flex-col">
      <div className="px-1 pb-1 text-xs text-text-muted tabular-nums">{open} open · {tasks.length - open} closed</div>
      {tasks.map((t) => <IssueRow key={t.id} mesh={mesh} task={t} board={board} />)}
    </div>
  );
}

// ── kanban ──────────────────────────────────────────────────────────────────
function KanbanView({ mesh, board, route }: { mesh: string; board: BoardDocument; route: { view: BoardView; filters: BoardFilters } }) {
  const tasks = applyFilters(board.tasks, board, route.filters);
  return (
    <div data-bnw-board-kanban className="flex gap-3 overflow-x-auto">
      {STATUS_ORDER.map((col) => {
        const items = tasks.filter((t) => t.status === col);
        return (
          <div key={col} className="flex w-60 shrink-0 flex-col gap-2">
            <div className="flex items-center gap-1.5 px-1 text-xs font-medium text-text-secondary"><StatusChip status={boardDot(col)} variant="dot" />{col} <span className="text-text-muted">({items.length})</span></div>
            {items.map((t) => (
              <RouteLink key={t.id} href={bnwHref({ k: "board", mesh, view: "kanban", issue: t.id, filters: {} })} unstyled
                className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised p-2 hover:bg-hover">
                <div className="flex items-center gap-1.5"><span className="text-xs tabular-nums text-text-muted">#{t.id}</span><span className="min-w-0 flex-1 truncate text-sm text-text-primary">{t.title}</span></div>
                <div className="flex items-center gap-2"><AssigneeTag name={t.assignee || "—"} size="sm" iconOnly /><PrioTag prio={t.priority} />{labelNames(t, board).slice(0, 2).map((n) => <LabelChip key={n} name={n} />)}</div>
              </RouteLink>
            ))}
            {items.length === 0 ? <div className="rounded-lg border border-dashed border-border px-2 py-3 text-center text-xs text-text-muted">—</div> : null}
          </div>
        );
      })}
    </div>
  );
}

// ── detail ──────────────────────────────────────────────────────────────────
function DetailView({ mesh, board, issue, view }: { mesh: string; board: BoardDocument; issue: number; view: BoardView }) {
  const task = board.tasks.find((t) => t.id === issue);
  if (!task) return <EmptyState title="issue 不存在" description={`#${issue} 不在该 mesh 的看板。`} action={<RouteLink href={bnwHref({ k: "board", mesh, view, filters: {} })}>返回列表</RouteLink>} />;
  const epic = task.epicId ? board.epics.find((e) => e.id === task.epicId) : undefined;
  const names = labelNames(task, board);
  return (
    <div data-bnw-board-detail className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        <span>by {task.createdBy}</span><span aria-hidden="true">·</span>
        <AssigneeTag name={task.assignee || "—"} size="sm" />
        <PrioTag prio={task.priority} />
        {epic ? <span className="text-text-muted">epic: {epic.title}</span> : null}
        {names.map((n) => <LabelChip key={n} name={n} />)}
      </div>
      {task.description ? <p className="whitespace-pre-wrap text-sm text-text-primary">{task.description}</p> : <p className="text-sm text-text-muted">（无描述）</p>}
      {task.subtasks.length ? (
        <div><div className="mb-1 text-xs uppercase tracking-wider text-text-muted">subtasks</div>
          <div className="flex flex-col gap-1">{task.subtasks.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-sm"><StatusChip status={boardDot(s.status)} variant="dot" /><span className="min-w-0 flex-1 truncate text-text-primary">{s.title}</span>{s.assignee ? <AssigneeTag name={s.assignee} size="sm" iconOnly /> : null}</div>
          ))}</div>
        </div>
      ) : null}
      {task.deps?.length ? <div className="text-xs text-text-secondary">blocked-by: {task.deps.map((d) => `#${d}`).join(", ")}</div> : null}
      {task.lifecycleEvents?.length ? (
        <div><div className="mb-1 text-xs uppercase tracking-wider text-text-muted">lifecycle</div>
          <div className="flex flex-wrap items-center gap-1 text-xs">{task.lifecycleEvents.map((e, i) => <span key={i} className="rounded bg-surface-sunken px-1.5 py-0.5 text-text-muted">{e.kind}</span>)}</div>
        </div>
      ) : null}
      {task.comments.length ? (
        <div><div className="mb-1 text-xs uppercase tracking-wider text-text-muted">activity</div>
          <div className="flex flex-col gap-1.5">{task.comments.map((c, i) => <div key={i} className="rounded border border-border px-2 py-1 text-xs"><span className="text-text-secondary">{c.author}</span> <span className="text-text-muted">{c.text}</span></div>)}</div>
        </div>
      ) : null}
      <p className="border-t border-border pt-2 text-xs text-text-muted">close / reopen / 评论 / 子任务编辑 接线于 7.2-B（本切片只读，不伪造）。</p>
    </div>
  );
}

// ── top ──────────────────────────────────────────────────────────────────────
export function BnwBoard({ store, state, mesh, route }: { store: Store; state: GatewayState; mesh: string; route: { view: BoardView; issue?: number; filters: BoardFilters } }) {
  const summary = state.meshes.find((m) => m.name === mesh);
  const board = state.perMesh[mesh]?.board ?? null;
  useEffect(() => { if (summary) void store.ensureBoardLoaded(mesh); }, [store, mesh, summary]);

  if (!summary) return <PanelFrame title="看板"><EmptyState title="mesh 不存在" description={`没有名为 “${mesh}” 的 mesh。`} action={<RouteLink href={bnwHref({ k: "home" })}>返回</RouteLink>} /></PanelFrame>;
  if (!board) return <PanelFrame title="看板"><EmptyState title="看板载入中…" description="尚无看板快照（mesh 未运行时可能为空）。" /></PanelFrame>;

  const title = route.issue
    ? <span><RouteLink href={bnwHref({ k: "board", mesh, view: route.view, filters: route.filters })} className="text-sm">◀</RouteLink> #{route.issue} · {board.tasks.find((t) => t.id === route.issue)?.title ?? "issue"}</span>
    : `看板 · ${board.tasks.length} issues`;

  return (
    <PanelFrame
      title={title}
      actions={route.issue ? <StatusChip status={boardDot(board.tasks.find((t) => t.id === route.issue)?.status ?? "todo")} variant="soft" label={board.tasks.find((t) => t.id === route.issue)?.status} /> : <Badge count={board.tasks.filter((t) => isOpen(t.status)).length} tone="neutral" />}
      className="h-full" bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
    >
      {route.issue ? (
        <DetailView mesh={mesh} board={board} issue={route.issue} view={route.view} />
      ) : (
        <>
          <BoardFilters mesh={mesh} route={route} board={board} />
          <div className="min-h-0 flex-1 overflow-auto">
            {route.view === "kanban" ? <KanbanView mesh={mesh} board={board} route={route} /> : <ListView mesh={mesh} board={board} route={route} />}
          </div>
        </>
      )}
    </PanelFrame>
  );
}
