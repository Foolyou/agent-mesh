// ISOLATED high-fidelity page mockup (Step 6) — NOT part of the product.
//
// Route-guarded at /__ui-mockup (index.tsx mounts this for that path; server.ts
// serves the SPA shell there ONLY when MESH_UI_PREVIEW=1, same guard as the C8
// gallery). Final mockups (desktop + mobile) from docs/design/ui/interaction/*,
// built from the REAL C5–C7 components (./ui/index) + the real v2 compose()/
// applyComposition() runtime, with FIXTURE data only — no backend, no store, no WS,
// no business-page migration. Surfaces delivered so far:
//   - application shell (01-app-shell.md): topbar/nav/stage/context framing.
//   - runtime view A (02-runtime-view.md): overview topology + focused transcript.
//   - board view C (03-board-view.md): issue list / detail / kanban (desktop) +
//     list / detail (mobile), GH-Issues maturity, fixture data.
//
// Query deep links for deterministic screenshots: ?device=desktop|mobile,
// ?surface=shell|runtime|board, ?runtime=overview|focus, ?board=list|detail|kanban,
// ?view=runtime|board, ?mesh=<id>, ?mode=<mode>, ?accent=<accent>. No raw-*
// utilities (passes `bun run lint:tokens`); all classes literal so Tailwind emits them.
//
// Live review: `MESH_UI_PREVIEW=1 bun run src/main.ts run --fake --port 15080`
// then open http://localhost:15080/__ui-mockup (404s without the flag).
import { useEffect, useState, type ReactNode } from "react";
import { MODES, ACCENTS, type Mode, type Accent, compose, applyComposition } from "./themes";
import {
  Button, StatusChip, Badge, SegmentedControl, StatusListRow, PanelFrame, ApprovalCard, Composer, ActionBar, Cluster,
  ProgressBar, AssigneeTag,
  type Status,
} from "./ui/index";

const MODE_LABEL: Record<Mode, string> = { "dark-slate": "Dark·Slate", "light-cool": "Light·Cool", "eye-care-warm": "Eye-care·Warm" };
const ACCENT_LABEL: Record<Accent, string> = { "signal-teal": "Signal Teal", ember: "Ember", "fleet-azure": "Fleet Azure" };
const MODE_SET = new Set<Mode>(MODES);
const ACCENT_SET = new Set<Accent>(ACCENTS);

type Device = "desktop" | "mobile";
type View = "runtime" | "board";
type Surface = "shell" | "runtime" | "board";
type RuntimeState = "overview" | "focus";
type BoardState = "list" | "detail" | "kanban";
const VIEW_LABEL: Record<View, string> = { runtime: "运行态", board: "看板" };

// Fixture meshes (no backend).
const MESHES: { id: string; status: Status }[] = [
  { id: "dev-mesh", status: "working" },
  { id: "alpha", status: "ready" },
  { id: "beta", status: "blocked" },
  { id: "docs-mesh", status: "idle" },
];

// Fixture agents for the runtime cockpit (status + pending approvals).
const AGENTS: { id: string; status: Status; pending: number }[] = [
  { id: "router", status: "ready", pending: 0 },
  { id: "codex-1", status: "working", pending: 1 },
  { id: "opencode-1", status: "blocked", pending: 0 },
  { id: "claude-1", status: "working", pending: 2 },
];
const FOCUS_AGENT = "codex-1"; // the agent whose transcript the focus state shows

// Fixture transcript for the focused agent (local message rows only — no product component).
const TRANSCRIPT: { who: "user" | "agent" | "tool"; text: string }[] = [
  { who: "user", text: "restart the alpha mesh and run the gate" },
  { who: "agent", text: "Starting alpha… running tsc + tests." },
  { who: "tool", text: "$ bun test  →  1548 pass / 0 fail" },
  { who: "agent", text: "Gate green. I need to write config.json — requesting approval." },
];

// ── board (C) fixtures ─────────────────────────────────────────────────────────
type Lifecycle = "todo" | "in_progress" | "in_review" | "done" | "cancelled";
const LIFECYCLE: { id: Lifecycle; label: string; status: Status }[] = [
  { id: "todo", label: "todo", status: "idle" },
  { id: "in_progress", label: "in_progress", status: "working" },
  { id: "in_review", label: "in_review", status: "attention" },
  { id: "done", label: "done", status: "done" },
  { id: "cancelled", label: "cancelled", status: "blocked" },
];
const lifeOf = (id: Lifecycle) => LIFECYCLE.find((l) => l.id === id)!;

interface Issue {
  n: number;
  title: string;
  status: Lifecycle;
  assignee: string;
  labels: string[];
  prio: "low" | "med" | "high";
  subDone: number;
  subTotal: number;
  blocked: boolean;
  updated: string;
  epic: string;
}
const EPICS: { id: string; name: string; open: number; closed: number; subDone: number; subTotal: number }[] = [
  { id: "onboarding", name: "Onboarding", open: 3, closed: 1, subDone: 9, subTotal: 14 },
  { id: "polish", name: "Polish", open: 0, closed: 2, subDone: 7, subTotal: 8 },
];
const ISSUES: Issue[] = [
  { n: 12, title: "Add device-auth page", status: "in_review", assignee: "codex-1", labels: ["auth", "ui"], prio: "high", subDone: 2, subTotal: 3, blocked: true, updated: "2d", epic: "onboarding" },
  { n: 14, title: "Wire route fallback", status: "todo", assignee: "", labels: ["infra"], prio: "med", subDone: 0, subTotal: 2, blocked: false, updated: "1h", epic: "onboarding" },
  { n: 9, title: "Token contrast audit", status: "in_progress", assignee: "claude-1", labels: ["a11y"], prio: "high", subDone: 1, subTotal: 4, blocked: false, updated: "5h", epic: "onboarding" },
  { n: 7, title: "Composer polish", status: "done", assignee: "codex-1", labels: ["ui"], prio: "low", subDone: 3, subTotal: 3, blocked: false, updated: "3d", epic: "polish" },
  { n: 5, title: "Drop legacy theme", status: "cancelled", assignee: "", labels: ["infra"], prio: "low", subDone: 0, subTotal: 0, blocked: false, updated: "6d", epic: "polish" },
];
const DETAIL_ISSUE = ISSUES[0]; // #12 — the issue the detail state shows
const TIMELINE: { kind: "lifecycle" | "comment"; text: string; when: string }[] = [
  { kind: "lifecycle", text: "dispatched → in_progress · by router", when: "3d" },
  { kind: "comment", text: "@codex-1: branch up, wiring the page", when: "2d" },
  { kind: "lifecycle", text: "review_requested → in_review", when: "1d" },
  { kind: "comment", text: "@router: looks good, blocked-by #9", when: "4h" },
];

interface Sel {
  device: Device;
  view: View;
  surface: Surface;
  runtime: RuntimeState;
  board: BoardState;
  mesh: string;
  mode: Mode;
  accent: Accent;
}

const MESH_IDS = new Set(MESHES.map((m) => m.id));

function readSel(): Sel {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const p = new URLSearchParams(search);
  const m = p.get("mode");
  const a = p.get("accent");
  const mesh = p.get("mesh");
  const sfc = p.get("surface");
  const surface: Surface = sfc === "runtime" ? "runtime" : sfc === "board" ? "board" : "shell";
  const bs = p.get("board");
  return {
    device: p.get("device") === "mobile" ? "mobile" : "desktop",
    view: p.get("view") === "board" ? "board" : "runtime",
    surface,
    runtime: p.get("runtime") === "focus" ? "focus" : "overview",
    board: bs === "detail" ? "detail" : bs === "kanban" ? "kanban" : "list",
    mesh: mesh && MESH_IDS.has(mesh) ? mesh : MESHES[0].id,
    mode: MODE_SET.has(m as Mode) ? (m as Mode) : "dark-slate",
    accent: ACCENT_SET.has(a as Accent) ? (a as Accent) : "signal-teal",
  };
}

const totalPending = AGENTS.reduce((n, a) => n + a.pending, 0);
const openCount = ISSUES.filter((i) => i.status !== "done" && i.status !== "cancelled").length;
const closedCount = ISSUES.length - openCount;

// ── shared shell pieces ──────────────────────────────────────────────────────
function Brand() {
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold text-text-primary">
      <span className="text-accent" aria-hidden="true">◈</span> Mesh
    </span>
  );
}

function ConnectionChip({ compact = false }: { compact?: boolean }) {
  return compact ? <StatusChip status="ready" variant="dot" label="connected" /> : <StatusChip status="ready" variant="soft" label="connected" />;
}

function StagePlaceholder({ view }: { view: View }) {
  return (
    <PanelFrame
      title={VIEW_LABEL[view]}
      description={view === "runtime" ? "对话 / 转录 / 审批（下一检查点）" : "Epic → Task → Subtask 看板（下一检查点）"}
      actions={<SegmentedControl ariaLabel="Stage filter" value="all" onChange={() => {}} options={[{ value: "all", label: "全部" }, { value: "mine", label: "我的" }]} size="sm" />}
      className="h-full"
      bodyClassName="h-full"
    >
      <div className="flex h-full min-h-[260px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-text-muted">
        {VIEW_LABEL[view]} 视图占位 — 本检查点只交付应用外壳
      </div>
    </PanelFrame>
  );
}

// ── runtime (A) fixtures — local, token-clean message rows (no product component) ──
function MessageBubble({ who, text }: { who: "user" | "agent" | "tool"; text: string }) {
  if (who === "tool") {
    return <pre className="my-1 overflow-x-auto rounded-lg bg-surface-sunken px-3 py-2 text-xs font-mono text-text-secondary">{text}</pre>;
  }
  const mine = who === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm text-text-primary ${mine ? "bg-accent-subtle" : "border border-border bg-surface-raised"}`}>
        <div className="mb-0.5 text-xs text-text-muted">{mine ? "you" : FOCUS_AGENT}</div>
        {text}
      </div>
    </div>
  );
}

function ApprovalFixture() {
  return (
    <ApprovalCard
      title={`${FOCUS_AGENT} · write file`}
      question={<>Allow <b>{FOCUS_AGENT}</b> to write <code className="text-syntax-string">config.json</code>?</>}
      options={[{ id: "allow", label: "Approve", kind: "approve" }, { id: "once", label: "Just once" }, { id: "deny", label: "Deny", kind: "reject" }]}
      onResolve={() => {}}
    />
  );
}

function ComposerFixture() {
  return (
    <Composer
      toolbar={<Button size="sm" variant="ghost" iconOnly aria-label="attach">📎</Button>}
      actions={<Button size="sm" variant="primary">Send</Button>}
      hint="Enter to send · Shift+Enter for newline"
    >
      <div className="px-1 py-1 text-sm text-text-muted">Message {FOCUS_AGENT}…</div>
    </Composer>
  );
}

function Transcript() {
  return (
    <div className="flex flex-col gap-2">
      {TRANSCRIPT.map((m, i) => <MessageBubble key={i} who={m.who} text={m.text} />)}
      <ApprovalFixture />
    </div>
  );
}

// Desktop runtime — overview: all-agent topology/status with approval red-dots.
function RuntimeOverviewDesktop({ focusHref }: { focusHref: (id: string) => string }) {
  return (
    <div data-runtime="overview" className="h-full">
      <PanelFrame
        title="Topology · 全体 agent"
        description={`${AGENTS.length} agents · ${totalPending} 待审批`}
        actions={<Cluster><Button size="sm" variant="ghost">⤢ 展开</Button><Button size="sm" variant="primary">Start</Button></Cluster>}
        className="h-full"
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {AGENTS.map((a) => (
            <a key={a.id} href={focusHref(a.id)} className="relative flex flex-col items-center gap-1.5 rounded-xl border border-border bg-surface-raised px-4 py-4 no-underline hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring">
              <StatusChip status={a.status} variant="dot" />
              <span className="text-sm font-medium text-text-primary">{a.id}</span>
              <span className="text-xs text-text-muted">{a.status}</span>
              {a.pending ? <span className="absolute -right-1.5 -top-1.5"><Badge count={a.pending} tone="urgent" /></span> : null}
            </a>
          ))}
        </div>
      </PanelFrame>
    </div>
  );
}

// Desktop runtime — focus: header + transcript + inline approval + composer.
function RuntimeFocusDesktop() {
  return (
    <div data-runtime="focus" className="flex h-full flex-col">
      <PanelFrame
        title={`运行态 · ${FOCUS_AGENT}`}
        description="focused transcript"
        actions={<Cluster><StatusChip status="working" variant="soft" /><Button size="sm" variant="ghost">Interrupt</Button><Button size="sm" variant="ghost">Restart</Button></Cluster>}
        className="flex-1"
        bodyClassName="flex flex-col gap-3"
        footer={<ComposerFixture />}
      >
        <Transcript />
      </PanelFrame>
    </div>
  );
}

// Mobile runtime — agent card list (pending approvals pinned on top).
function RuntimeListMobile({ focusHref }: { focusHref: (id: string) => string }) {
  const pending = AGENTS.filter((a) => a.pending > 0);
  return (
    <div data-runtime="overview" className="flex flex-col gap-3">
      {pending.length ? (
        <PanelFrame title={`⚠ 待审批 (${totalPending})`}>
          <div className="flex flex-col gap-1">
            {pending.map((a) => (
              <StatusListRow key={a.id} status="attention" title={`${a.id} · 请求写文件`} href={focusHref(a.id)} trailing={<Badge count={a.pending} tone="urgent" />} />
            ))}
          </div>
        </PanelFrame>
      ) : null}
      <PanelFrame title="Agents">
        <div className="flex flex-col gap-1">
          {AGENTS.map((a) => (
            <StatusListRow
              key={a.id}
              status={a.status}
              title={a.id}
              meta={a.status}
              href={focusHref(a.id)}
              trailing={a.pending ? <Badge count={a.pending} tone="urgent" /> : undefined}
            />
          ))}
        </div>
      </PanelFrame>
    </div>
  );
}

// Mobile runtime — focus: approval pinned ABOVE the transcript, then composer.
function RuntimeFocusMobile() {
  return (
    <div data-runtime="focus" className="flex flex-col gap-3">
      <ActionBar ariaLabel={`${FOCUS_AGENT} actions`} end={<Button size="sm" variant="ghost">Interrupt</Button>}>
        <StatusChip status="working" variant="soft" />
        <span className="text-sm text-text-secondary">{FOCUS_AGENT}</span>
      </ActionBar>
      <ApprovalFixture />
      <PanelFrame title="Transcript">
        <div className="flex flex-col gap-2">
          {TRANSCRIPT.map((m, i) => <MessageBubble key={i} who={m.who} text={m.text} />)}
        </div>
      </PanelFrame>
      <ComposerFixture />
    </div>
  );
}

// ── board (A) fixtures — local, token-clean parts (label colors are board data,
//    so LabelChip uses neutral semantic tokens, not per-label colors). ───────────
function LabelChip({ name }: { name: string }) {
  return <span className="inline-flex items-center gap-0.5 rounded border border-border bg-surface-sunken px-1.5 py-0.5 text-xs text-text-secondary">🏷 {name}</span>;
}
function PrioTag({ prio }: { prio: Issue["prio"] }) {
  const tone = prio === "high" ? "text-danger" : prio === "med" ? "text-warning" : "text-text-muted";
  return <span className={`text-xs font-medium ${tone}`}>{prio}</span>;
}
function SubtaskProgress({ done, total }: { done: number; total: number }) {
  if (total === 0) return <span className="text-xs text-text-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-12"><ProgressBar value={done} max={total} label={`subtasks ${done}/${total}`} /></span>
      <span className="text-xs text-text-muted tabular-nums">{done}/{total}</span>
    </span>
  );
}

// Desktop issue row — local (richer than StatusListRow's fixed shape), token-clean.
function IssueRow({ issue }: { issue: Issue }) {
  const life = lifeOf(issue.status);
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3 py-2 hover:bg-hover">
      <input type="checkbox" aria-label={`select #${issue.n}`} className="accent-accent" />
      <StatusChip status={life.status} variant="dot" />
      <span className="w-9 shrink-0 text-xs tabular-nums text-text-muted">#{issue.n}</span>
      <a href={`/__ui-mockup?surface=board&board=detail`} className="min-w-0 flex-1 truncate text-sm text-text-primary no-underline hover:text-link">{issue.title}</a>
      {issue.blocked ? <span className="text-danger" title="blocked" aria-label="blocked">⛔</span> : null}
      <span className="hidden items-center gap-1 lg:flex">{issue.labels.map((l) => <LabelChip key={l} name={l} />)}</span>
      <span className="w-7 shrink-0 text-center text-xs text-text-muted">{life.label.slice(0, 2)}</span>
      <AssigneeTag name={issue.assignee || "—"} size="sm" iconOnly />
      <PrioTag prio={issue.prio} />
      <SubtaskProgress done={issue.subDone} total={issue.subTotal} />
      <span className="w-8 shrink-0 text-right text-xs text-text-muted">{issue.updated}</span>
    </div>
  );
}

function EpicGroupHeader({ epicId }: { epicId: string }) {
  const e = EPICS.find((x) => x.id === epicId)!;
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface-sunken px-3 py-1.5">
      <span aria-hidden="true" className="text-text-muted">▾</span>
      <span className="text-sm font-medium text-text-primary">Epic: {e.name}</span>
      <span className="text-xs text-text-muted">({e.open} open · {e.closed} closed · subtasks {e.subDone}/{e.subTotal})</span>
    </div>
  );
}

function BoardFilterBar() {
  return (
    <ActionBar
      ariaLabel="board filters"
      end={<Cluster><Button size="sm" variant="secondary">Dispatch ▾</Button><Button size="sm" variant="primary">+ Issue</Button></Cluster>}
    >
      <input aria-label="search issues" placeholder="search…" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary placeholder:text-text-muted" />
      <select aria-label="status filter" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary"><option>status</option></select>
      <select aria-label="label filter" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary"><option>label</option></select>
      <select aria-label="assignee filter" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary"><option>assignee</option></select>
      <select aria-label="epic filter" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary"><option>epic</option></select>
      <select aria-label="sort" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary"><option>updated</option></select>
    </ActionBar>
  );
}

function BoardBulkToolbar() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-sunken px-3 py-1.5 text-xs">
      <label className="inline-flex items-center gap-1.5"><input type="checkbox" aria-label="select all" className="accent-accent" /> select all</label>
      <span className="text-text-muted">bulk:</span>
      <Button size="sm" variant="ghost">status ▾</Button>
      <Button size="sm" variant="ghost">label ▾</Button>
      <Button size="sm" variant="ghost">epic ▾</Button>
      <Button size="sm" variant="ghost">assignee ▾</Button>
      <Button size="sm" variant="ghost">close</Button>
      <span className="flex-1" aria-hidden="true" />
      <span className="text-text-muted tabular-nums">{openCount} open · {closedCount} closed</span>
    </div>
  );
}

// Desktop board — List (GitHub-Issues maturity).
function BoardListDesktop() {
  return (
    <div data-board="list" className="h-full">
      <PanelFrame title="Board · Issues" actions={<SegmentedControl ariaLabel="Board view" value="list" onChange={() => {}} size="sm" options={[{ value: "list", label: "List" }, { value: "kanban", label: "Board" }]} />} className="h-full" bodyClassName="flex flex-col gap-2">
        <BoardFilterBar />
        <BoardBulkToolbar />
        <div className="flex flex-col gap-2">
          {EPICS.map((e) => (
            <div key={e.id} className="flex flex-col">
              <EpicGroupHeader epicId={e.id} />
              {ISSUES.filter((i) => i.epic === e.id).map((i) => <IssueRow key={i.n} issue={i} />)}
            </div>
          ))}
        </div>
      </PanelFrame>
    </div>
  );
}

// Lifecycle auto-flow path strip (visualizes todo→…→done; current highlighted).
function LifecyclePath({ current }: { current: Lifecycle }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {LIFECYCLE.filter((l) => l.id !== "cancelled").map((l, i) => (
        <span key={l.id} className="inline-flex items-center gap-1">
          {i > 0 ? <span aria-hidden="true" className="text-text-muted">→</span> : null}
          <span className={`rounded px-1.5 py-0.5 ${l.id === current ? "bg-accent-subtle text-accent" : "text-text-muted"}`}>{l.label}</span>
        </span>
      ))}
    </div>
  );
}

// Desktop board — Detail.
function BoardDetailDesktop() {
  const it = DETAIL_ISSUE;
  return (
    <div data-board="detail" className="h-full">
      <PanelFrame
        title={<span><a href="/__ui-mockup?surface=board&board=list" className="text-link no-underline">◀</a> #{it.n} · {it.title}</span>}
        actions={<Cluster><StatusChip status={lifeOf(it.status).status} variant="soft" label={it.status} /><Button size="sm" variant="secondary">close ▾</Button></Cluster>}
        className="h-full"
        bodyClassName="flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
          <span>by router · opened 3d</span><span aria-hidden="true">·</span>
          <AssigneeTag name={it.assignee} size="sm" />
          {it.labels.map((l) => <LabelChip key={l} name={l} />)}
          <span aria-hidden="true">·</span><span>epic: Onboarding</span>
          <span aria-hidden="true">·</span><PrioTag prio={it.prio} />
        </div>
        <LifecyclePath current={it.status} />
        <p className="text-sm text-text-primary">Add the device-code authorization page so a new browser can enroll and reach the console. Markdown body…</p>
        <div className="flex items-center gap-2 text-sm"><span className="text-text-muted">subtasks</span><SubtaskProgress done={it.subDone} total={it.subTotal} /></div>
        <div className="text-sm"><span className="text-text-muted">deps:</span> blocked-by <span className="text-danger">#9 (⛔ open)</span></div>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-text-muted">activity timeline</div>
          <ul className="flex flex-col gap-2">
            {TIMELINE.map((t, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span aria-hidden="true" className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${t.kind === "lifecycle" ? "bg-accent" : "bg-border-strong"}`} />
                <span className="flex-1 text-text-primary">{t.text}</span>
                <span className="text-xs text-text-muted">{t.when}</span>
              </li>
            ))}
          </ul>
        </div>
        <Composer actions={<Button size="sm" variant="primary">Comment</Button>} hint="markdown supported"><div className="px-1 py-1 text-sm text-text-muted">Leave a comment…</div></Composer>
        <ActionBar ariaLabel="issue controls"><Button size="sm" variant="ghost">status ▾</Button><Button size="sm" variant="ghost">assignee ▾</Button><Button size="sm" variant="ghost">labels ▾</Button><Button size="sm" variant="ghost">epic ▾</Button><Button size="sm" variant="ghost">deps ▾</Button></ActionBar>
      </PanelFrame>
    </div>
  );
}

function KanbanCard({ issue }: { issue: Issue }) {
  return (
    <a href="/__ui-mockup?surface=board&board=detail" className="block rounded-lg border border-border bg-surface-raised px-2.5 py-2 no-underline hover:bg-hover">
      <div className="flex items-center gap-1.5 text-xs text-text-muted"><span className="tabular-nums">#{issue.n}</span>{issue.blocked ? <span className="text-danger" aria-label="blocked">⛔</span> : null}</div>
      <div className="mt-0.5 truncate text-sm text-text-primary">{issue.title}</div>
      <div className="mt-1.5 flex items-center justify-between gap-1">
        <AssigneeTag name={issue.assignee || "—"} size="sm" iconOnly />
        <span className="flex items-center gap-1">{issue.labels.slice(0, 1).map((l) => <LabelChip key={l} name={l} />)}</span>
      </div>
    </a>
  );
}

// Desktop board — Kanban (lifecycle columns; horizontal scroll keeps columns roomy).
function BoardKanbanDesktop() {
  return (
    <div data-board="kanban" className="h-full">
      <PanelFrame title="Board · Kanban" description="swimlanes: epic ▾ · drag = set_status (perm-gated)" actions={<SegmentedControl ariaLabel="Board view" value="kanban" onChange={() => {}} size="sm" options={[{ value: "list", label: "List" }, { value: "kanban", label: "Board" }]} />} className="h-full">
        <div className="flex gap-3 overflow-x-auto pb-2">
          {LIFECYCLE.map((col) => {
            const cards = ISSUES.filter((i) => i.status === col.id);
            return (
              <div key={col.id} className="flex w-[180px] shrink-0 flex-col gap-2">
                <div className="flex items-center gap-1.5 px-1">
                  <StatusChip status={col.status} variant="dot" />
                  <span className="text-sm font-medium text-text-primary">{col.label}</span>
                  <span className="text-xs text-text-muted">{cards.length}</span>
                </div>
                <div className="flex flex-col gap-2 rounded-lg bg-surface-sunken p-2">
                  {cards.length ? cards.map((i) => <KanbanCard key={i.n} issue={i} />) : <span className="px-1 py-3 text-center text-xs text-text-muted">—</span>}
                </div>
              </div>
            );
          })}
        </div>
      </PanelFrame>
    </div>
  );
}

// Mobile board — issue card (list-first).
function MobileIssueCard({ issue }: { issue: Issue }) {
  const life = lifeOf(issue.status);
  return (
    <a href="/__ui-mockup?device=mobile&surface=board&board=detail" className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised px-3 py-2 no-underline">
      <div className="flex items-center gap-2">
        <StatusChip status={life.status} variant="dot" />
        <span className="text-xs tabular-nums text-text-muted">#{issue.n}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{issue.title}</span>
        {issue.blocked ? <span className="text-danger" aria-label="blocked">⛔</span> : null}
      </div>
      <div className="flex items-center gap-2 pl-6">
        <AssigneeTag name={issue.assignee || "—"} size="sm" />
        {issue.labels.map((l) => <LabelChip key={l} name={l} />)}
      </div>
    </a>
  );
}

function BoardListMobile() {
  return (
    <div data-board="list" className="flex flex-col gap-3">
      <ActionBar ariaLabel="board filters" end={<Button size="sm" variant="primary">+ Issue</Button>}>
        <input aria-label="search issues" placeholder="search…" className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary placeholder:text-text-muted" />
        <select aria-label="status filter" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary"><option>status</option></select>
      </ActionBar>
      <PanelFrame title={`Issues · ${openCount} open`}>
        <div className="flex flex-col gap-2">
          {ISSUES.map((i) => <MobileIssueCard key={i.n} issue={i} />)}
        </div>
      </PanelFrame>
    </div>
  );
}

function BoardDetailMobile() {
  const it = DETAIL_ISSUE;
  return (
    <div data-board="detail" className="flex flex-col gap-3">
      <ActionBar ariaLabel={`#${it.n} controls`} end={<Button size="sm" variant="secondary">close ▾</Button>}>
        <a href="/__ui-mockup?device=mobile&surface=board&board=list" className="text-link no-underline">◀</a>
        <StatusChip status={lifeOf(it.status).status} variant="soft" label={it.status} />
        <span className="text-sm text-text-primary">#{it.n}</span>
      </ActionBar>
      <PanelFrame title={it.title}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
          <AssigneeTag name={it.assignee} size="sm" />
          {it.labels.map((l) => <LabelChip key={l} name={l} />)}
          <PrioTag prio={it.prio} />
        </div>
        <div className="mt-2 flex items-center gap-2 text-sm"><span className="text-text-muted">subtasks</span><SubtaskProgress done={it.subDone} total={it.subTotal} /></div>
      </PanelFrame>
      <PanelFrame title="Activity">
        <ul className="flex flex-col gap-2">
          {TIMELINE.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span aria-hidden="true" className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${t.kind === "lifecycle" ? "bg-accent" : "bg-border-strong"}`} />
              <span className="flex-1 text-text-primary">{t.text}</span>
              <span className="text-xs text-text-muted">{t.when}</span>
            </li>
          ))}
        </ul>
      </PanelFrame>
      <Composer actions={<Button size="sm" variant="primary">Comment</Button>}><div className="px-1 py-1 text-sm text-text-muted">Leave a comment…</div></Composer>
    </div>
  );
}

// ── desktop shell ────────────────────────────────────────────────────────────
function DesktopShell({ view, setView, mesh, setMesh, meshHref, stage, contextTitle, context }: { view: View; setView: (v: View) => void; mesh: string; setMesh: (m: string) => void; meshHref: (id: string) => string; stage: ReactNode; contextTitle: string; context: ReactNode }) {
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [ctxCollapsed, setCtxCollapsed] = useState(false);
  return (
    <div data-mockup="frame" data-device="desktop" className="w-[1280px] max-w-full overflow-hidden rounded-xl border border-border bg-surface text-text-primary shadow-sm">
      {/* topbar */}
      <header className="flex items-center gap-3 border-b border-border bg-surface-raised px-4 py-2.5">
        <Brand />
        <ConnectionChip />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        {/* Adaptive mesh control: when the left nav is expanded it IS the primary mesh
            switcher, so the topbar shows the current mesh as a non-interactive label.
            When the nav is collapsed (list hidden), the topbar falls back to a select. */}
        {navCollapsed ? (
          <label data-topbar-mesh="select" className="inline-flex items-center gap-1.5 text-sm">
            <span className="text-text-muted">mesh</span>
            <select value={mesh} onChange={(e) => setMesh(e.target.value)} aria-label="active mesh" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary">
              {MESHES.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </label>
        ) : (
          <span data-topbar-mesh="label" aria-label="current mesh" className="inline-flex items-center gap-1.5 text-sm">
            <span className="text-text-muted">mesh</span>
            <span className="font-medium text-text-primary">{mesh}</span>
          </span>
        )}
        <SegmentedControl
          ariaLabel="View"
          value={view}
          onChange={(v) => setView(v as View)}
          options={[{ value: "runtime", label: "运行态" }, { value: "board", label: "看板" }]}
          size="sm"
        />
        <span className="flex-1" aria-hidden="true" />
        <Button variant="ghost" size="sm" iconOnly aria-label="通知 (3 未读)" className="relative">
          🔔<span className="absolute -right-1 -top-1"><Badge count={3} tone="urgent" /></span>
        </Button>
        <Button variant="ghost" size="sm">管理▾</Button>
        <Button variant="ghost" size="sm">设置▾</Button>
      </header>

      {/* body: left nav · stage · right context */}
      <div className="relative flex min-h-[520px]">
        {/* Collapsed → the left nav is hidden ENTIRELY (no rail, no status dots); only a
            small floating button at the left edge restores it, and the stage takes the
            freed width. Expanded → the full primary mesh switcher. */}
        {navCollapsed ? (
          <div className="absolute left-2 top-2 z-10">
            <Button data-nav-expand variant="secondary" size="sm" iconOnly aria-label="展开导航" onClick={() => setNavCollapsed(false)}>»</Button>
          </div>
        ) : (
          <nav aria-label="meshes" className="w-[232px] shrink-0 border-r border-border bg-surface-raised p-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="px-1 text-xs uppercase tracking-wider text-text-muted">meshes</span>
              <Button variant="ghost" size="sm" iconOnly aria-label="收起导航" onClick={() => setNavCollapsed(true)}>«</Button>
            </div>
            <div className="flex flex-col gap-1">
              {/* Primary mesh switcher: each row is a real link-like affordance (RouteLink <a>). */}
              {MESHES.map((m) => (
                <StatusListRow key={m.id} status={m.status} title={m.id} href={meshHref(m.id)} active={m.id === mesh} />
              ))}
              <div className="mt-2"><Button variant="primary" size="sm" className="w-full">+ New mesh</Button></div>
            </div>
          </nav>
        )}

        <main className={`min-w-0 flex-1 p-3 ${navCollapsed ? "pl-12" : ""}`}>{stage}</main>

        {!ctxCollapsed ? (
          <aside aria-label="context" className="w-[288px] shrink-0 border-l border-border bg-surface-raised p-3">
            <PanelFrame
              title={contextTitle}
              actions={<Button variant="ghost" size="sm" iconOnly aria-label="收起上下文" onClick={() => setCtxCollapsed(true)}>»</Button>}
            >
              {context}
            </PanelFrame>
          </aside>
        ) : (
          <div className="shrink-0 border-l border-border bg-surface-raised p-2">
            <Button variant="ghost" size="sm" iconOnly aria-label="展开上下文" onClick={() => setCtxCollapsed(false)}>«</Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── mobile shell ─────────────────────────────────────────────────────────────
type MobileTab = "runtime" | "board" | "more";
const MOBILE_TAB_LABEL: Record<MobileTab, string> = { runtime: "运行态", board: "看板", more: "更多" };

function MobileShell({ tab, setTab, mesh, setMesh, stage, stageTab }: { tab: MobileTab; setTab: (t: MobileTab) => void; mesh: string; setMesh: (m: string) => void; stage?: ReactNode; stageTab?: MobileTab }) {
  return (
    <div data-mockup="frame" data-device="mobile" className="relative flex h-[760px] w-[390px] max-w-full flex-col overflow-hidden rounded-[28px] border border-border bg-surface text-text-primary shadow-sm">
      {/* slim topbar */}
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-3 py-2.5">
        <Brand />
        <ConnectionChip compact />
        <span className="flex-1" aria-hidden="true" />
        {/* No left nav on mobile, so the topbar always keeps the mesh select. */}
        <label data-topbar-mesh="select" className="inline-flex items-center">
          <select value={mesh} onChange={(e) => setMesh(e.target.value)} aria-label="active mesh" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary">
            {MESHES.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
        </label>
      </header>

      {/* active view */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === "more" ? (
          <PanelFrame title="更多">
            <div className="flex flex-col gap-1">
              <StatusListRow status="attention" title="🔔 通知" meta="3" href="/__ui-mockup?device=mobile" trailing={<Badge count={3} tone="urgent" />} />
              <StatusListRow status="ready" title="管理 · Assistant / Harnesses / Channels / Doctor" href="/__ui-mockup?device=mobile" />
              <StatusListRow status="ready" title="设置 · 主题 / 语言 / 鉴权 / 设备" href="/__ui-mockup?device=mobile" />
            </div>
          </PanelFrame>
        ) : stage && tab === stageTab ? (
          stage
        ) : (
          <StagePlaceholder view={tab} />
        )}
      </div>

      {/* bottom tabs */}
      <nav aria-label="主导航" role="tablist" className="flex items-stretch border-t border-border bg-surface-raised">
        {(["runtime", "board", "more"] as MobileTab[]).map((t) => {
          const active = t === tab;
          return (
            <button
              key={t}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t)}
              className={`flex-1 px-2 py-3 text-center text-xs font-medium ${active ? "text-accent" : "text-text-secondary"} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring`}
            >
              {MOBILE_TAB_LABEL[t]}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function selQuery(s: Sel): string {
  const p = new URLSearchParams();
  p.set("device", s.device);
  p.set("view", s.view);
  p.set("surface", s.surface);
  p.set("runtime", s.runtime);
  p.set("board", s.board);
  p.set("mesh", s.mesh);
  p.set("mode", s.mode);
  p.set("accent", s.accent);
  return p.toString();
}

export function UiMockup() {
  const [sel, setSel] = useState<Sel>(readSel);
  const { device, view, surface, runtime, board, mesh, mode, accent } = sel;
  const [mobileTab, setMobileTab] = useState<MobileTab>(surface === "board" || view === "board" ? "board" : "runtime");

  useEffect(() => {
    applyComposition(compose(mode, accent));
  }, [mode, accent]);
  useEffect(() => {
    const onPop = () => setSel(readSel());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const nav = (next: Partial<Sel>) => {
    const merged = { ...sel, ...next };
    setSel(merged);
    window.history.replaceState({}, "", `/__ui-mockup?${selQuery(merged)}`);
  };

  // Real link target for a mesh row (RouteLink SPA-navigates; popstate re-reads state).
  const meshHref = (id: string) => `/__ui-mockup?${selQuery({ ...sel, mesh: id })}`;
  // Topology/agent node → focus that agent's transcript (runtime focus state).
  const focusHref = (_agentId: string) => `/__ui-mockup?${selQuery({ ...sel, surface: "runtime", runtime: "focus" })}`;
  const setMesh = (m: string) => nav({ mesh: m });

  const setView = (v: View) => {
    nav({ view: v });
    if (v === "board" || v === "runtime") setMobileTab(v);
  };

  // Stage + right-context content: the empty shell placeholder, the runtime (A)
  // mockup, or the board (C) mockup.
  const desktopStage = surface === "runtime"
    ? (runtime === "focus" ? <RuntimeFocusDesktop /> : <RuntimeOverviewDesktop focusHref={focusHref} />)
    : surface === "board"
    ? (board === "detail" ? <BoardDetailDesktop /> : board === "kanban" ? <BoardKanbanDesktop /> : <BoardListDesktop />)
    : <StagePlaceholder view={view} />;
  const contextTitle = surface === "runtime"
    ? (runtime === "focus" ? `${FOCUS_AGENT} · activity` : "Topology detail")
    : surface === "board" ? "Epics · dispatch" : "Context";
  const desktopContext = surface === "runtime"
    ? (runtime === "focus" ? (
        <div className="flex flex-col gap-3 text-sm">
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-text-muted">activity</div>
            <div className="flex flex-col gap-1">
              <StatusListRow status="working" title="running gate" meta="now" />
              <StatusListRow status="done" title="compacted context" meta="3m" />
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-text-muted">mail</div>
            <div className="flex flex-col gap-1">
              <StatusListRow status="attention" title="→ router: need approval" meta="now" trailing={<Badge count={1} tone="urgent" />} />
              <StatusListRow status="ready" title="← router: proceed" meta="5m" />
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-text-secondary">选中一个节点查看其活动与邮件；待审批以红点/计数高亮在节点上。</p>
      ))
    : surface === "board" ? (
        <div className="flex flex-col gap-3 text-sm">
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-text-muted">epics</div>
            <div className="flex flex-col gap-1">
              {EPICS.map((e) => <StatusListRow key={e.id} status={e.open ? "working" : "done"} title={e.name} meta={`${e.open}/${e.open + e.closed}`} />)}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-text-muted">router dispatch</div>
            <Button size="sm" variant="primary" className="w-full">Dispatch issue ▾</Button>
          </div>
        </div>
      )
    : <p className="text-sm text-text-secondary">按需上下文由当前视图拥有（运行态/看板各自填充）。</p>;

  // Mobile functional stage (runtime or board); shell → no stage (placeholder).
  const mobileStage = surface === "runtime"
    ? (runtime === "focus" ? <RuntimeFocusMobile /> : <RuntimeListMobile focusHref={focusHref} />)
    : surface === "board"
    ? (board === "detail" ? <BoardDetailMobile /> : <BoardListMobile />)
    : undefined;
  const mobileStageTab: MobileTab = surface === "board" ? "board" : "runtime";

  return (
    <div data-mockup="root" className="min-h-screen bg-surface text-text-primary font-sans p-6">
      {/* mockup tool chrome (outside the mocked app frame) */}
      <header className="mb-5">
        <h1 className="mb-1 text-xl font-semibold">Agent Mesh — 终稿 mockup（Step 6 · {surface === "runtime" ? "运行态 A" : surface === "board" ? "看板 C" : "应用外壳"} · {device === "mobile" ? "移动" : "桌面"}）</h1>
        <p className="mb-3 text-xs text-text-muted">真实 C5–C7 组件 + v2 compose 运行时 · fixture 数据 · 不连后端。Live: <code className="text-syntax-string">MESH_UI_PREVIEW=1 … /__ui-mockup</code></p>
        <div className="flex flex-wrap items-start gap-5">
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">设备</div>
            <SegmentedControl ariaLabel="Device" value={device} onChange={(d) => nav({ device: d as Device })} options={[{ value: "desktop", label: "桌面" }, { value: "mobile", label: "移动" }]} size="sm" />
          </div>
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">Background mode</div>
            <SegmentedControl ariaLabel="Background mode" value={mode} onChange={(m) => nav({ mode: m })} options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))} size="sm" />
          </div>
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">Accent</div>
            <SegmentedControl ariaLabel="Accent" value={accent} onChange={(a) => nav({ accent: a })} options={ACCENTS.map((a) => ({ value: a, label: ACCENT_LABEL[a] }))} size="sm" />
          </div>
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">Surface</div>
            <SegmentedControl ariaLabel="Surface" value={surface} onChange={(s) => { const next = s as Surface; nav({ surface: next }); if (next === "board") setMobileTab("board"); else if (next === "runtime") setMobileTab("runtime"); }} options={[{ value: "shell", label: "外壳" }, { value: "runtime", label: "运行态 A" }, { value: "board", label: "看板 C" }]} size="sm" />
          </div>
          {surface === "runtime" ? (
            <div>
              <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">Runtime state</div>
              <SegmentedControl ariaLabel="Runtime state" value={runtime} onChange={(r) => nav({ runtime: r as RuntimeState })} options={[{ value: "overview", label: "Overview" }, { value: "focus", label: "Focus" }]} size="sm" />
            </div>
          ) : null}
          {surface === "board" ? (
            <div>
              <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">Board state</div>
              <SegmentedControl
                ariaLabel="Board state"
                value={board}
                onChange={(b) => nav({ board: b as BoardState })}
                options={device === "mobile"
                  ? [{ value: "list", label: "List" }, { value: "detail", label: "Detail" }]
                  : [{ value: "list", label: "List" }, { value: "detail", label: "Detail" }, { value: "kanban", label: "Kanban" }]}
                size="sm"
              />
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex justify-center">
        {device === "mobile"
          ? <MobileShell tab={mobileTab} setTab={(t) => { setMobileTab(t); if (t === "runtime" || t === "board") nav({ view: t }); }} mesh={mesh} setMesh={setMesh} stage={mobileStage} stageTab={mobileStageTab} />
          : <DesktopShell view={view} setView={setView} mesh={mesh} setMesh={setMesh} meshHref={meshHref} stage={desktopStage} contextTitle={contextTitle} context={desktopContext} />}
      </div>
    </div>
  );
}
