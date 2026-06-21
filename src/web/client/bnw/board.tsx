// Step 7.2-A/B — new /bnw Board C views (list / kanban / detail) + C4 GH-Issues filter shell,
// wired to the REAL store.board (ensureBoardLoaded + board snapshots) and REAL store.boardCommand
// (CAS expectedBoardRevision; 409 → the store silently refetches/reconciles). Independent view
// layer: shares the store only; does NOT import or modify the old BoardPanel. Mirrors the
// confirmed C4 mockup (/__ui-mockup?surface=board) + coverage/03-board.md.
//
// 7.2-A = read + filter/nav (filters live in the URL). 7.2-B adds real mutations + parity:
// #22 board fullscreen, #24 manage-labels CRUD + palette, #25 create task/epic + reopen
// terminal, set-status, comment, dispatch, kanban drag→set_status. No fakes.
import { useEffect, useState } from "react";
import {
  AssigneeTag, Badge, Button, Cluster, Composer, ConfirmButton, EmptyState, Input, PanelFrame,
  ProgressBar, RouteLink, SegmentedControl, Select, StatusChip, Textarea, type Status,
} from "../ui/index";
import type { Store } from "../store";
import type { GatewayState } from "../../types";
import type { BoardDocument, BoardStatus, BoardPriority, BoardCommand, Task, Epic } from "../../../board";
import { LABEL_PALETTE } from "../../../board";
import { bnwHref, navigate, type BoardFilters, type BoardView } from "../router";

const STATUS_ORDER: BoardStatus[] = ["todo", "in_progress", "in_review", "done", "cancelled"];
const PRIOS: BoardPriority[] = ["low", "normal", "high", "urgent"];
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
const isTerminal = (s: BoardStatus) => s === "done" || s === "cancelled";
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
// readable ink on a palette swatch (luminance threshold)
function labelInk(hex: string): string {
  const h = hex.replace("#", ""); const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 140 ? "#111827" : "#f9fafb";
}
function labelNames(task: Task, board: BoardDocument): string[] {
  const labels = board.labels ?? [];
  return (task.labelIds ?? []).map((id) => labels.find((l) => l.id === id)?.name).filter((n): n is string => !!n);
}
function blockedBy(task: Task, board: BoardDocument): boolean {
  return (task.deps ?? []).some((d) => { const dep = board.tasks.find((t) => t.id === d); return dep ? isOpen(dep.status) : false; });
}
function subtaskProgress(task: Task): { done: number; total: number } {
  return { done: task.subtasks.filter((s) => s.status === "done").length, total: task.subtasks.length };
}
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
    return b.id - a.id;
  });
  return out;
}

// Real-mutation runner: store.boardCommand with the board-level CAS (board.revision); the store
// handles 409 by refetch+rethrow (→ toast). Returns busy + run for inline disabled/clear UX.
type Apply = (cmd: BoardCommand) => Promise<unknown>;
function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (p: Promise<unknown>) => { setBusy(true); try { await p; } catch { /* store toasts */ } finally { setBusy(false); } };
  return { busy, run };
}

function LabelChip({ name }: { name: string }) {
  return <span className="inline-flex items-center gap-0.5 rounded border border-border bg-surface-sunken px-1.5 py-0.5 text-xs text-text-secondary">🏷 {name}</span>;
}
function PrioTag({ prio }: { prio: string }) {
  return <span className={`text-xs font-medium ${prio === "urgent" || prio === "high" ? "text-danger" : "text-text-muted"}`}>{prio}</span>;
}
function SubProgress({ task }: { task: Task }) {
  const { done, total } = subtaskProgress(task);
  if (total === 0) return null;
  return <span className="inline-flex items-center gap-1.5"><span className="w-12"><ProgressBar value={done} max={total} label={`subtasks ${done}/${total}`} /></span><span className="text-xs tabular-nums text-text-muted">{done}/{total}</span></span>;
}

// ── C4 GH-Issues filter shell (nav-driven; filters live in the URL) ───────────
function BoardFilterShell({ mesh, route, board, onToggleCreate, onToggleManage, onToggleFs, fs }: {
  mesh: string; route: { view: BoardView; filters: BoardFilters }; board: BoardDocument;
  onToggleCreate: () => void; onToggleManage: () => void; onToggleFs: () => void; fs: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const f = route.filters;
  const go = (next: BoardFilters, view: BoardView = route.view) => navigate({ k: "board", mesh, view, filters: next });
  const setF = (patch: Partial<BoardFilters>) => go({ ...f, ...patch });
  const labels = board.labels ?? [];
  const assignees = Array.from(new Set(board.tasks.map((t) => t.assignee).filter((a): a is string => !!a)));
  const applied = (["status", "label", "assignee", "epic", "q"] as const).filter((k) => f[k]).map((k) => ({ k, v: f[k] as string }));
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
          <SegmentedControl ariaLabel="Board view" value={route.view} size="sm" onChange={(v) => go(f, v as BoardView)} options={[{ value: "list", label: "List" }, { value: "kanban", label: "Board" }]} />
          <Select aria-label="sort" value={f.sort ?? "number"} onChange={(e) => setF({ sort: e.target.value })} className="w-24"><option value="number">number</option><option value="updated">updated</option><option value="created">created</option><option value="priority">priority</option></Select>
          <Button size="sm" variant="secondary" aria-label="manage labels" onClick={onToggleManage}>🏷 标签</Button>
          <Button size="sm" variant="ghost" iconOnly aria-label={fs ? "exit fullscreen" : "fullscreen"} onClick={onToggleFs}>{fs ? "🗕" : "🗖"}</Button>
          <Button size="sm" variant="primary" aria-label="new issue" onClick={onToggleCreate}>+ 新建</Button>
        </Cluster></span>
      </div>
      {menu ? (
        <div role="menu" data-bnw-filter-menu className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-raised p-2">
          <Select aria-label="status filter" value={f.status ?? ""} onChange={(e) => setF({ status: e.target.value || undefined })} className="w-32"><option value="">status: any</option><option value="open">open</option>{STATUS_ORDER.map((s) => <option key={s} value={s}>{s}</option>)}</Select>
          <Select aria-label="label filter" value={f.label ?? ""} onChange={(e) => setF({ label: e.target.value || undefined })} className="w-32"><option value="">label: any</option>{labels.map((l) => <option key={l.id} value={l.name}>{l.name}</option>)}</Select>
          <Select aria-label="assignee filter" value={f.assignee ?? ""} onChange={(e) => setF({ assignee: e.target.value || undefined })} className="w-32"><option value="">assignee: any</option>{assignees.map((a) => <option key={a} value={a}>{a}</option>)}</Select>
          <Select aria-label="epic filter" value={f.epic ?? ""} onChange={(e) => setF({ epic: e.target.value || undefined })} className="w-36"><option value="">epic: any</option>{board.epics.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</Select>
          <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary"><input type="checkbox" aria-label="group by epic" checked={f.group === "epic"} onChange={(e) => setF({ group: e.target.checked ? "epic" : undefined })} className="accent-accent" /> 按 Epic 分组</label>
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

// #25 — create task + create epic (real create_task / create_epic).
function CreateRow({ apply }: { apply: Apply }) {
  const { busy, run } = useBusy();
  const [task, setTask] = useState(""); const [epic, setEpic] = useState("");
  return (
    <div data-bnw-board-create className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-sunken p-2">
      <Input aria-label="new task" placeholder="new task…" value={task} className="w-48" onChange={(e) => setTask(e.target.value)} />
      <Button size="sm" variant="primary" busy={busy} disabled={!task.trim()} aria-label="create task" onClick={async () => { await run(apply({ type: "create_task", title: task.trim() })); setTask(""); }}>+ task</Button>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
      <Input aria-label="new epic" placeholder="new epic…" value={epic} className="w-40" onChange={(e) => setEpic(e.target.value)} />
      <Button size="sm" variant="secondary" busy={busy} disabled={!epic.trim()} aria-label="create epic" onClick={async () => { await run(apply({ type: "create_epic", title: epic.trim() })); setEpic(""); }}>+ epic</Button>
    </div>
  );
}

// #24 — manage labels: create / rename / recolor / delete, with the accessible LABEL_PALETTE.
function PaletteRow({ selected, onPick, ariaLabel }: { selected: string; onPick: (c: string) => void; ariaLabel: string }) {
  return (
    <span role="group" aria-label={ariaLabel} data-bnw-palette className="inline-flex flex-wrap items-center gap-1">
      {LABEL_PALETTE.map((c) => (
        <button key={c} type="button" aria-label={`color ${c}`} aria-pressed={c === selected} onClick={() => onPick(c)}
          className={`h-5 w-5 rounded-full border ${c === selected ? "border-border-strong" : "border-border"}`} style={{ background: c }} />
      ))}
    </span>
  );
}
function LabelManager({ apply, board }: { apply: Apply; board: BoardDocument }) {
  const { busy, run } = useBusy();
  const [name, setName] = useState(""); const [color, setColor] = useState(LABEL_PALETTE[4]);
  const labels = board.labels ?? [];
  return (
    <div data-bnw-board-labels className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">管理标签 · 创建 / 重命名 / 改色 / 删除</span>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="new label name" placeholder="标签名" value={name} className="w-40" onChange={(e) => setName(e.target.value)} />
        <PaletteRow selected={color} onPick={setColor} ariaLabel="new label color" />
        <Button size="sm" variant="secondary" busy={busy} disabled={!name.trim()} aria-label="add label" onClick={async () => { await run(apply({ type: "create_label", name: name.trim(), color })); setName(""); }}>+ 添加标签</Button>
      </div>
      <div className="flex flex-col gap-1.5">
        {labels.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs" style={{ background: l.color, color: labelInk(l.color) }}>🏷 {l.name}</span>
            <Input defaultValue={l.name} aria-label={`rename ${l.name}`} className="w-32" onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== l.name) void apply({ type: "update_label", id: l.id, name: v }); }} />
            <PaletteRow selected={l.color} onPick={(c) => void apply({ type: "update_label", id: l.id, color: c })} ariaLabel={`recolor ${l.name}`} />
            <ConfirmButton size="sm" variant="ghost" confirmLabel="删除?" aria-label={`delete ${l.name}`} onConfirm={() => void apply({ type: "delete_label", id: l.id })}>×</ConfirmButton>
          </div>
        ))}
        {labels.length === 0 ? <span className="text-xs text-text-muted">还没有标签。</span> : null}
      </div>
    </div>
  );
}

// ── list ──────────────────────────────────────────────────────────────────────
function IssueRow({ mesh, task, board, filters }: { mesh: string; task: Task; board: BoardDocument; filters: BoardFilters }) {
  const names = labelNames(task, board);
  return (
    <RouteLink href={bnwHref({ k: "board", mesh, view: "list", issue: task.id, filters })} unstyled
      className="flex items-center gap-2.5 border-b border-border px-3 py-2 hover:bg-hover">
      <StatusChip status={boardDot(task.status)} variant="dot" />
      <span className="w-9 shrink-0 text-xs tabular-nums text-text-muted">#{task.id}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{task.title}</span>
      {blockedBy(task, board) ? <span className="text-danger" title="blocked" aria-label="blocked">⛔</span> : null}
      <span className="hidden items-center gap-1 lg:flex">{names.map((n) => <LabelChip key={n} name={n} />)}</span>
      <AssigneeTag name={task.assignee || "—"} size="sm" iconOnly />
      <PrioTag prio={task.priority} />
      <SubProgress task={task} />
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
            {g.items.map((t) => <IssueRow key={t.id} mesh={mesh} task={t} board={board} filters={route.filters} />)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div data-bnw-board-list className="flex flex-col">
      <div className="px-1 pb-1 text-xs text-text-muted tabular-nums">{open} open · {tasks.length - open} closed</div>
      {tasks.map((t) => <IssueRow key={t.id} mesh={mesh} task={t} board={board} filters={route.filters} />)}
    </div>
  );
}

// ── kanban (drag a card to a column → set_task_status) ────────────────────────
function KanbanView({ mesh, board, route, apply }: { mesh: string; board: BoardDocument; route: { view: BoardView; filters: BoardFilters }; apply: Apply }) {
  const [over, setOver] = useState<BoardStatus | null>(null);
  const tasks = applyFilters(board.tasks, board, route.filters);
  const drop = (col: BoardStatus, id: number) => { const task = board.tasks.find((t) => t.id === id); if (task && task.status !== col) void apply({ type: "set_task_status", id, expectedRevision: task.revision, status: col }); };
  return (
    <div data-bnw-board-kanban className="flex gap-3 overflow-x-auto">
      {STATUS_ORDER.map((col) => {
        const items = tasks.filter((t) => t.status === col);
        return (
          <div key={col} data-bnw-kanban-col={col} onDragOver={(e) => { e.preventDefault(); setOver(col); }} onDragLeave={() => setOver((c) => (c === col ? null : c))}
            onDrop={(e) => { e.preventDefault(); setOver(null); const id = Number(e.dataTransfer.getData("text/bnw-task")); if (Number.isInteger(id)) drop(col, id); }}
            className={`flex w-60 shrink-0 flex-col gap-2 rounded-lg p-1 ${over === col ? "bg-hover ring-1 ring-accent" : ""}`}>
            <div className="flex items-center gap-1.5 px-1 text-xs font-medium text-text-secondary"><StatusChip status={boardDot(col)} variant="dot" />{col} <span className="text-text-muted">({items.length})</span></div>
            {items.map((t) => (
              <div key={t.id} draggable data-bnw-card onDragStart={(e) => e.dataTransfer.setData("text/bnw-task", String(t.id))}>
                <RouteLink href={bnwHref({ k: "board", mesh, view: "kanban", issue: t.id, filters: route.filters })} unstyled
                  className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised p-2 hover:bg-hover">
                  <div className="flex items-center gap-1.5"><span className="text-xs tabular-nums text-text-muted">#{t.id}</span><span className="min-w-0 flex-1 truncate text-sm text-text-primary">{t.title}</span></div>
                  <div className="flex items-center gap-2"><AssigneeTag name={t.assignee || "—"} size="sm" iconOnly /><PrioTag prio={t.priority} />{labelNames(t, board).slice(0, 2).map((n) => <LabelChip key={n} name={n} />)}</div>
                </RouteLink>
              </div>
            ))}
            {items.length === 0 ? <div className="rounded-lg border border-dashed border-border px-2 py-3 text-center text-xs text-text-muted">—</div> : null}
          </div>
        );
      })}
    </div>
  );
}

// ── detail (real mutations: status / priority / assignee / close / reopen / comment / dispatch) ──
function DetailView({ mesh, board, issue, view, filters, apply, agents }: { mesh: string; board: BoardDocument; issue: number; view: BoardView; filters: BoardFilters; apply: Apply; agents: string[] }) {
  const { busy, run } = useBusy();
  const [comment, setComment] = useState("");
  const [dispatchee, setDispatchee] = useState(agents[0] ?? "");
  const task = board.tasks.find((t) => t.id === issue);
  if (!task) return <EmptyState title="issue 不存在" description={`#${issue} 不在该 mesh 的看板。`} action={<RouteLink href={bnwHref({ k: "board", mesh, view, filters })}>返回列表</RouteLink>} />;
  const epic = task.epicId ? board.epics.find((e) => e.id === task.epicId) : undefined;
  const names = labelNames(task, board);
  const terminal = isTerminal(task.status);
  const rev = task.revision;
  return (
    <div data-bnw-board-detail className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        <span>by {task.createdBy}</span><span aria-hidden="true">·</span>
        <label className="inline-flex items-center gap-1">status
          <Select aria-label="task status" value={task.status} disabled={busy} className="w-28" onChange={(e) => void run(apply({ type: "set_task_status", id: task.id, expectedRevision: rev, status: e.target.value as BoardStatus }))}>{STATUS_ORDER.map((s) => <option key={s} value={s}>{s}</option>)}</Select>
        </label>
        <label className="inline-flex items-center gap-1">priority
          <Select aria-label="task priority" value={task.priority} disabled={busy} className="w-24" onChange={(e) => void run(apply({ type: "set_task_priority", id: task.id, expectedRevision: rev, priority: e.target.value as BoardPriority }))}>{PRIOS.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
        </label>
        <label className="inline-flex items-center gap-1">assignee
          <Select aria-label="task assignee" value={task.assignee ?? ""} disabled={busy} className="w-28" onChange={(e) => void run(apply({ type: "assign_task", id: task.id, expectedRevision: rev, assignee: e.target.value || undefined }))}><option value="">—</option>{agents.map((a) => <option key={a} value={a}>{a}</option>)}</Select>
        </label>
        {epic ? <span className="text-text-muted">epic: {epic.title}</span> : null}
        {names.map((n) => <LabelChip key={n} name={n} />)}
      </div>
      {task.description ? <p className="whitespace-pre-wrap text-sm text-text-primary">{task.description}</p> : <p className="text-sm text-text-muted">（无描述）</p>}
      {/* dispatch (router hand-off): assign + linkage + dispatched + status→in_progress in one command */}
      <div data-bnw-dispatch className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2 py-1.5 text-xs">
        <span className="text-text-muted">dispatch →</span>
        <Select aria-label="dispatch assignee" value={dispatchee} disabled={busy} className="w-28" onChange={(e) => setDispatchee(e.target.value)}>{agents.length === 0 ? <option value="">（无 agent）</option> : agents.map((a) => <option key={a} value={a}>{a}</option>)}</Select>
        <Button size="sm" variant="secondary" busy={busy} disabled={!dispatchee} aria-label="dispatch task" onClick={() => void run(apply({ type: "dispatch_task", id: task.id, expectedRevision: rev, assignee: dispatchee, taskSlug: slugify(task.title) }))}>Dispatch</Button>
      </div>
      {task.subtasks.length ? (
        <div><div className="mb-1 text-xs uppercase tracking-wider text-text-muted">subtasks</div>
          <div className="flex flex-col gap-1">{task.subtasks.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-sm"><StatusChip status={boardDot(s.status)} variant="dot" /><span className="min-w-0 flex-1 truncate text-text-primary">{s.title}</span>
              <Select aria-label={`subtask ${s.id} status`} value={s.status} disabled={busy} className="w-24" onChange={(e) => void run(apply({ type: "set_subtask_status", taskId: task.id, subtaskId: s.id, expectedRevision: s.revision, status: e.target.value as BoardStatus }))}>{STATUS_ORDER.map((x) => <option key={x} value={x}>{x}</option>)}</Select>
            </div>
          ))}</div>
        </div>
      ) : null}
      {task.deps?.length ? <div className="text-xs text-text-secondary">blocked-by: {task.deps.map((d) => `#${d}`).join(", ")}</div> : null}
      {task.lifecycleEvents?.length ? (
        <div><div className="mb-1 text-xs uppercase tracking-wider text-text-muted">lifecycle</div>
          <div className="flex flex-wrap items-center gap-1 text-xs">{task.lifecycleEvents.map((e, i) => <span key={i} className="rounded bg-surface-sunken px-1.5 py-0.5 text-text-muted">{e.kind}</span>)}</div>
        </div>
      ) : null}
      <div><div className="mb-1 text-xs uppercase tracking-wider text-text-muted">activity</div>
        <div className="flex flex-col gap-1.5">
          {task.comments.map((c, i) => <div key={i} className="rounded border border-border px-2 py-1 text-xs"><span className="text-text-secondary">{c.author}</span> <span className="text-text-muted">{c.text}</span></div>)}
          {task.comments.length === 0 ? <p className="text-xs text-text-muted">暂无评论。</p> : null}
        </div>
      </div>
      {/* comment composer (real add_comment) */}
      <Composer ariaLabel="comment composer" actions={<Button size="sm" variant="primary" busy={busy} disabled={!comment.trim()} aria-label="add comment" onClick={async () => { await run(apply({ type: "add_comment", target: { kind: "task", id: task.id }, expectedRevision: rev, text: comment.trim() })); setComment(""); }}>评论</Button>}>
        <Textarea aria-label="comment input" rows={2} value={comment} placeholder="写条评论…" onChange={(e) => setComment(e.target.value)} />
      </Composer>
      {/* close / reopen — the sanctioned terminal transitions */}
      <div className="flex items-center gap-2 border-t border-border pt-2">
        {terminal
          ? <Button size="sm" variant="secondary" busy={busy} aria-label="reopen issue" onClick={() => void run(apply({ type: "record_lifecycle_event", taskId: task.id, expectedRevision: rev, kind: "reopened" }))}>↺ reopen</Button>
          : <><ConfirmButton size="sm" variant="secondary" confirmLabel="关闭为 done?" aria-label="close done" onConfirm={() => void run(apply({ type: "set_task_status", id: task.id, expectedRevision: rev, status: "done" }))}>close ✓</ConfirmButton>
             <ConfirmButton size="sm" variant="ghost" confirmLabel="取消?" aria-label="close cancelled" onConfirm={() => void run(apply({ type: "set_task_status", id: task.id, expectedRevision: rev, status: "cancelled" }))}>cancel</ConfirmButton></>}
      </div>
    </div>
  );
}

// ── top ──────────────────────────────────────────────────────────────────────
export function BnwBoard({ store, state, mesh, route }: { store: Store; state: GatewayState; mesh: string; route: { view: BoardView; issue?: number; filters: BoardFilters } }) {
  const summary = state.meshes.find((m) => m.name === mesh);
  const board = state.perMesh[mesh]?.board ?? null;
  const [fs, setFs] = useState(false);
  const [manage, setManage] = useState(false);
  const [create, setCreate] = useState(false);
  useEffect(() => { if (summary) void store.ensureBoardLoaded(mesh); }, [store, mesh, summary]);

  if (!summary) return <PanelFrame title="看板"><EmptyState title="mesh 不存在" description={`没有名为 “${mesh}” 的 mesh。`} action={<RouteLink href={bnwHref({ k: "home" })}>返回</RouteLink>} /></PanelFrame>;
  if (!board) return <PanelFrame title="看板"><EmptyState title="看板载入中…" description="尚无看板快照（mesh 未运行时可能为空）。" /></PanelFrame>;

  const apply: Apply = (cmd) => store.boardCommand(mesh, cmd, board.revision);
  const agents = summary.agents.map((a) => a.id);
  const detailTask = route.issue ? board.tasks.find((t) => t.id === route.issue) : undefined;
  const title = route.issue
    ? <span><RouteLink href={bnwHref({ k: "board", mesh, view: route.view, filters: route.filters })} className="text-sm">◀</RouteLink> #{route.issue} · {detailTask?.title ?? "issue"}</span>
    : `看板 · ${board.tasks.length} issues`;

  const panel = (
    <PanelFrame
      title={title}
      actions={route.issue
        ? <Cluster><Button size="sm" variant="ghost" iconOnly aria-label={fs ? "exit fullscreen" : "fullscreen"} onClick={() => setFs((v) => !v)}>{fs ? "🗕" : "🗖"}</Button><StatusChip status={boardDot(detailTask?.status ?? "todo")} variant="soft" label={detailTask?.status} /></Cluster>
        : <Badge count={board.tasks.filter((t) => isOpen(t.status)).length} tone="neutral" />}
      className="h-full" bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
    >
      {route.issue ? (
        <DetailView mesh={mesh} board={board} issue={route.issue} view={route.view} filters={route.filters} apply={apply} agents={agents} />
      ) : (
        <>
          <BoardFilterShell mesh={mesh} route={route} board={board} fs={fs}
            onToggleCreate={() => setCreate((v) => !v)} onToggleManage={() => setManage((v) => !v)} onToggleFs={() => setFs((v) => !v)} />
          {create ? <CreateRow apply={apply} /> : null}
          {manage ? <LabelManager apply={apply} board={board} /> : null}
          <div className="min-h-0 flex-1 overflow-auto">
            {route.view === "kanban" ? <KanbanView mesh={mesh} board={board} route={route} apply={apply} /> : <ListView mesh={mesh} board={board} route={route} />}
          </div>
        </>
      )}
    </PanelFrame>
  );

  // #22 board fullscreen — expand the board to a standalone overlay over the whole shell.
  if (fs) return <div data-bnw-board-fs className="fixed inset-0 z-40 bg-surface p-3">{panel}</div>;
  return panel;
}
