// ISOLATED high-fidelity page mockup (Step 6) — NOT part of the product.
//
// Route-guarded at /__ui-mockup (index.tsx mounts this for that path; server.ts
// serves the SPA shell there ONLY when MESH_UI_PREVIEW=1, same guard as the C8
// gallery). Final mockups (desktop + mobile) from docs/design/ui/interaction/*,
// built from the REAL C5–C7 components (./ui/index) + the real v2 compose()/
// applyComposition() runtime, with FIXTURE data only — no backend, no store, no WS,
// no business-page migration. Surfaces delivered so far:
//   - application shell (01-app-shell.md): topbar/nav/stage/context framing.
//   - runtime view A (02-runtime-view.md): overview topology + focused transcript,
//     plus the audited [E] abilities — per-agent mode/model/effort/kimi selectors,
//     wake cold agent, context/health usage, pending-turn queue, transcript expanders,
//     jump/load-older, session fullscreen (runtime=full) and the zoomable topology
//     canvas (runtime=canvas), live add agent/edge, start strategy + new-all-sessions.
//   - board view C (03-board-view.md): issue list / detail / kanban (desktop) +
//     list / detail (mobile), GH-Issues maturity, fixture data, plus the audited [E]
//     abilities — fullscreen (?boardFs=1), group-by-epic, label CRUD + palette
//     (?boardManage=1), create-epic, and reopen of closed (terminal) issues.
//   - new mesh builder (04): agents / edges / charter / per-agent controls.
//   - Mesh Assistant (05-assistant.md): NL controller chat + tool-call cards
//     (create/delete/update-mesh) + inline delete-confirm + chat fullscreen
//     (?asstFs=1) + folded p2p-DM entry; absent → "not configured" + enable.
//   - Harnesses (06-harnesses.md): per-harness status + dual version + auth + reprobe +
//     install/update, install progress (retry-stream/close), self-install guide, and
//     old-version-agent restarts (after-idle / force / cancel).
//   - Channels (07-channels.md): Feishu status + chat→mesh bindings (provision/QR) +
//     pending-sender auth-code inbox (approve/revoke) + allowSenders registry (revoke).
//   - Doctor / system (08-doctor-system.md): doctor findings (host-key/port/deps/config/
//     service) + ps daemon table + leak recovery (reap orphan / restart daemon) + copy
//     diagnostics + app/build version.
//   - Settings (09-settings.md): appearance (mode×accent 3×3 + custom palette) + language +
//     default-view/default-device prefs + device authorization (approve/revoke/bootstrap).
//   - Notifications (10-notifications.md): app-level cross-mesh notice center ([N]) — unread
//     badge + list/drawer + read/mark-read/mark-all + history + follow-actions targeting the
//     [E] surfaces (harnesses/doctor/settings). NOT transcript / mesh-local mail.
//   - File/artifact viewer (11-file-viewer.md): rendered markdown/code/image at an artifact
//     route + back-to-conversation + image lightbox (?lb=1) + composer pending-image tray.
//   - Device-auth gate (12-device-auth.md): pre-auth unauthorized landing — device code +
//     host-CLI approve + poll + body-only bootstrap token + expiry retry + remembered deep link.
//   - navigation index (?index=1): a directory of every surface + state/device deep links.
//
// Query deep links for deterministic screenshots: ?device=desktop|mobile,
// ?surface=shell|runtime|board|new-mesh|assistant|harnesses|channels|doctor|settings|notifications|artifact|device-auth, ?runtime=overview|focus|full|canvas,
// ?board=list|detail|kanban, ?state=<shell-state>, ?index=1, ?view=runtime|board,
// ?mesh=<id>, ?mode=<mode>, ?accent=<accent>. No raw-* utilities (passes
// `bun run lint:tokens`); all classes literal so Tailwind emits them.
//
// Live review: `MESH_UI_PREVIEW=1 bun run src/main.ts run --fake --port 15080`
// then open http://localhost:15080/__ui-mockup (404s without the flag).
import { useEffect, useState, type ReactNode } from "react";
import { MODES, ACCENTS, type Mode, type Accent, compose, applyComposition } from "./themes";
import {
  Button, ConfirmButton, StatusChip, Badge, SegmentedControl, StatusListRow, PanelFrame, ApprovalCard, Composer, ActionBar, Cluster,
  ProgressBar, AssigneeTag, Spinner, Skeleton, EmptyState, ErrorBanner, Input, Textarea, Select,
  type Status,
} from "./ui/index";

const MODE_LABEL: Record<Mode, string> = { "dark-slate": "Dark·Slate", "light-cool": "Light·Cool", "eye-care-warm": "Eye-care·Warm" };
const ACCENT_LABEL: Record<Accent, string> = { "signal-teal": "Signal Teal", ember: "Ember", "fleet-azure": "Fleet Azure" };
const MODE_SET = new Set<Mode>(MODES);
const ACCENT_SET = new Set<Accent>(ACCENTS);

type Device = "desktop" | "mobile";
type View = "runtime" | "board";
type Surface = "shell" | "runtime" | "board" | "new-mesh" | "assistant" | "harnesses" | "channels" | "doctor" | "settings" | "notifications" | "artifact" | "device-auth";
// overview/focus = the two in-shell runtime states; full/canvas = desktop-only standalone
// frames (session fullscreen / zoomable topology canvas) reached from the focus / overview.
type RuntimeState = "overview" | "focus" | "full" | "canvas";
const RUNTIME_VIEWS: RuntimeState[] = ["overview", "focus", "full", "canvas"];
type BoardState = "list" | "detail" | "kanban";
const VIEW_LABEL: Record<View, string> = { runtime: "运行态", board: "看板" };

// Fixture meshes (no backend).
const MESHES: { id: string; status: Status }[] = [
  { id: "dev-mesh", status: "working" },
  { id: "alpha", status: "ready" },
  { id: "beta", status: "blocked" },
  { id: "docs-mesh", status: "idle" },
];

// Fixture agents for the runtime cockpit (status + pending approvals). `cold` agents
// are lazy/asleep and expose a Wake affordance instead of a focus link (audit #11).
type RuntimeAgent = { id: string; status: Status; pending: number; cold?: boolean };
const AGENTS: RuntimeAgent[] = [
  { id: "router", status: "ready", pending: 0 },
  { id: "codex-1", status: "working", pending: 1 },
  { id: "opencode-1", status: "blocked", pending: 0 },
  { id: "claude-1", status: "working", pending: 2 },
  { id: "kimi-cold", status: "idle", pending: 0, cold: true },
];
const FOCUS_AGENT = "codex-1"; // the agent whose transcript the focus state shows

// Queued turns waiting behind the in-flight one (pending-turn queue, audit #13).
const QUEUED_TURNS = [
  { text: "after the gate, bump the harness versions and re-probe" },
  { text: "then open a PR against main and ping me" },
];

// Boundary/scale: many agents (several pending) for the overview/list at scale.
const MANY_AGENTS: RuntimeAgent[] = [
  ...AGENTS,
  { id: "claude-2", status: "working", pending: 1 }, { id: "codex-2", status: "ready", pending: 0 },
  { id: "opencode-2", status: "attention", pending: 3 }, { id: "kimi-1", status: "working", pending: 0 },
  { id: "router-2", status: "idle", pending: 0 }, { id: "claude-3", status: "blocked", pending: 1 },
  { id: "codex-3", status: "working", pending: 0 }, { id: "reviewer-1", status: "attention", pending: 2 },
];

// Fixture transcript for the focused agent (local message rows only — no product component).
const TRANSCRIPT: { who: "user" | "agent" | "tool"; text: string }[] = [
  { who: "user", text: "restart the alpha mesh and run the gate" },
  { who: "agent", text: "Starting alpha… running tsc + tests." },
  { who: "tool", text: "$ bun test  →  1548 pass / 0 fail" },
  { who: "agent", text: "Gate green. I need to write config.json — requesting approval." },
];
// Boundary: a long transcript (gives the virtualized/long-scroll feel in the mockup).
const LONG_TRANSCRIPT: { who: "user" | "agent" | "tool"; text: string }[] = Array.from({ length: 7 }, (_, i) => TRANSCRIPT[i % TRANSCRIPT.length]).concat([
  { who: "user", text: "also bump the harness versions and re-probe" },
  { who: "agent", text: "Re-probing harnesses… codex-acp 1.2.3 · codex 0.141.0." },
  { who: "tool", text: "$ bun run a11y  →  palette 8+9 · DOM e2e 19/0" },
  { who: "agent", text: "All green. A very long line to exercise wrapping and truncation behavior across the transcript bubble width so we can see how it reflows on both desktop and the narrow mobile frame." },
]);

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
// Boundary/scale: many issues incl. a very long title + many labels, deeper epic tree.
const MANY_EPICS: typeof EPICS = [
  ...EPICS,
  { id: "infra", name: "Infrastructure", open: 6, closed: 4, subDone: 12, subTotal: 22 },
  { id: "security", name: "Security audit", open: 2, closed: 1, subDone: 3, subTotal: 9 },
];
const MANY_ISSUES: Issue[] = [
  ...ISSUES,
  { n: 21, title: "A very long issue title that should truncate gracefully without breaking the row layout on desktop or the narrow mobile card", status: "in_progress", assignee: "claude-1", labels: ["infra", "perf", "a11y", "ui", "auth"], prio: "high", subDone: 3, subTotal: 9, blocked: true, updated: "10m", epic: "infra" },
  { n: 22, title: "Rotate device keys", status: "todo", assignee: "router", labels: ["security"], prio: "high", subDone: 0, subTotal: 5, blocked: false, updated: "1h", epic: "security" },
  { n: 23, title: "Cache board snapshots", status: "in_review", assignee: "codex-2", labels: ["perf", "infra"], prio: "med", subDone: 4, subTotal: 6, blocked: false, updated: "2h", epic: "infra" },
  { n: 24, title: "Audit auth-codes envelope", status: "done", assignee: "reviewer-1", labels: ["security", "auth"], prio: "high", subDone: 5, subTotal: 5, blocked: false, updated: "1d", epic: "security" },
  { n: 25, title: "Virtualize long transcripts", status: "in_progress", assignee: "claude-2", labels: ["perf", "ui"], prio: "med", subDone: 2, subTotal: 7, blocked: false, updated: "3h", epic: "infra" },
  { n: 26, title: "Drop dead CSS", status: "cancelled", assignee: "", labels: ["ui"], prio: "low", subDone: 0, subTotal: 0, blocked: false, updated: "4d", epic: "infra" },
];

const DETAIL_ISSUE = ISSUES[0]; // #12 — the issue the detail state shows

// Accessible label palette (mirrors board.ts LABEL_PALETTE — each clears AA against
// whichever of black/white wins) + fixture labels for the CRUD/recolor manager (audit #24).
const LABEL_PALETTE = ["#fde68a", "#ffd6a5", "#fecaca", "#e9d5ff", "#bae6fd", "#b7e4c7", "#d9f99d", "#a5f3fc", "#1e3a8a", "#6d28d9", "#b91c1c", "#047857", "#92400e", "#374151"];
const BOARD_LABELS: { id: string; name: string; color: string }[] = [
  { id: "label-1", name: "auth", color: "#bae6fd" },
  { id: "label-2", name: "ui", color: "#e9d5ff" },
  { id: "label-3", name: "infra", color: "#374151" },
  { id: "label-4", name: "a11y", color: "#b7e4c7" },
  { id: "label-5", name: "perf", color: "#ffd6a5" },
  { id: "label-6", name: "security", color: "#fecaca" },
];
// Pick black/white ink for a swatch by luminance (mirrors BoardPanel.labelForeground).
function labelText(bg: string): string {
  const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.52 ? "#000000" : "#ffffff";
}

const TIMELINE: { kind: "lifecycle" | "comment"; text: string; when: string }[] = [
  { kind: "lifecycle", text: "dispatched → in_progress · by router", when: "3d" },
  { kind: "comment", text: "@codex-1: branch up, wiring the page", when: "2d" },
  { kind: "lifecycle", text: "review_requested → in_review", when: "1d" },
  { kind: "comment", text: "@router: looks good, blocked-by #9", when: "4h" },
];

// Boundary/scale detail fixture: long title/body, many labels, more subtasks,
// multiple deps, longer activity/comment timeline (#21 from MANY_ISSUES).
const DETAIL_BOUNDARY: Issue = MANY_ISSUES.find((i) => i.n === 21)!;
const BOUNDARY_BODY =
  "Refactor the device-auth + board snapshot path end-to-end so a fresh browser can enroll, " +
  "resolve its remembered deep link, and stream a large board without jank. This issue carries a " +
  "deliberately long markdown body to exercise wrapping, paragraph spacing, and scroll inside the " +
  "detail surface on both desktop and the narrow mobile frame. It also enumerates many subtasks and " +
  "several cross-issue dependencies so the detail pressure is visible, not just the list.";
const BOUNDARY_DEPS = ["#9 (⛔ open)", "#14 (open)", "#22 (open)", "#23 (in_review)", "#24 (done)"];
const BOUNDARY_SUBTASKS = ["scaffold enrollment page", "wire bootstrap token", "gate /api/*", "cache snapshot", "virtualize list", "perf budget", "a11y pass", "docs", "e2e"];
const BOUNDARY_TIMELINE: { kind: "lifecycle" | "comment"; text: string; when: string }[] = [
  { kind: "lifecycle", text: "created · by router", when: "12d" },
  { kind: "comment", text: "@router: dispatching to claude-1; blocked-by #9, #14", when: "11d" },
  { kind: "lifecycle", text: "dispatched → in_progress · by router", when: "10d" },
  { kind: "comment", text: "@claude-1: split into 9 subtasks; starting enrollment page", when: "9d" },
  { kind: "comment", text: "@codex-2: cache layer landed (#23), unblocks snapshot streaming", when: "6d" },
  { kind: "lifecycle", text: "set labels: infra, perf, a11y, ui, auth", when: "5d" },
  { kind: "comment", text: "@reviewer-1: security audit of auth-codes envelope ok (#24)", when: "3d" },
  { kind: "comment", text: "@claude-1: 3/9 subtasks done; still blocked-by #9 (open)", when: "10m" },
];

interface Sel {
  device: Device;
  view: View;
  surface: Surface;
  runtime: RuntimeState;
  board: BoardState;
  state: ShellState;
  nmEditor: NmEditor;
  boardFs: boolean;
  boardManage: boolean;
  asstFs: boolean;
  lb: boolean;
  index: boolean;
  mesh: string;
  mode: Mode;
  accent: Accent;
}
type NmEditor = "off" | "charter" | "instructions";

const MESH_IDS = new Set(MESHES.map((m) => m.id));

function readSel(): Sel {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const p = new URLSearchParams(search);
  const m = p.get("mode");
  const a = p.get("accent");
  const mesh = p.get("mesh");
  const sfc = p.get("surface");
  const surface: Surface = sfc === "runtime" ? "runtime" : sfc === "board" ? "board" : sfc === "new-mesh" ? "new-mesh" : sfc === "assistant" ? "assistant" : sfc === "harnesses" ? "harnesses" : sfc === "channels" ? "channels" : sfc === "doctor" ? "doctor" : sfc === "settings" ? "settings" : sfc === "notifications" ? "notifications" : sfc === "artifact" ? "artifact" : sfc === "device-auth" ? "device-auth" : "shell";
  const bs = p.get("board");
  const rt = p.get("runtime") as RuntimeState | null;
  const st = p.get("state") as ShellState | null;
  return {
    device: p.get("device") === "mobile" ? "mobile" : "desktop",
    view: p.get("view") === "board" ? "board" : "runtime",
    surface,
    runtime: rt && RUNTIME_VIEWS.includes(rt) ? rt : "overview",
    board: bs === "detail" ? "detail" : bs === "kanban" ? "kanban" : "list",
    state: st && SHELL_STATES.includes(st) ? st : "populated",
    nmEditor: p.get("nmEditor") === "charter" ? "charter" : p.get("nmEditor") === "instructions" ? "instructions" : "off",
    boardFs: p.get("boardFs") === "1",
    boardManage: p.get("boardManage") === "1",
    asstFs: p.get("asstFs") === "1",
    lb: p.get("lb") === "1",
    index: p.get("index") === "1",
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

type Connection = "connected" | "connecting" | "offline";
const CONN: Record<Connection, { status: Status; label: string }> = {
  connected: { status: "ready", label: "connected" },
  connecting: { status: "working", label: "connecting…" },
  offline: { status: "blocked", label: "offline" },
};
function ConnectionChip({ compact = false, connection = "connected" }: { compact?: boolean; connection?: Connection }) {
  const c = CONN[connection];
  return compact ? <StatusChip status={c.status} variant="dot" label={c.label} /> : <StatusChip status={c.status} variant="soft" label={c.label} />;
}

// Shell display state (Phase B surface 01). Drives the deterministic ?state= switch.
type ShellState = "empty" | "loading" | "populated" | "error" | "permission" | "busy" | "offline" | "boundary";
const SHELL_STATES: ShellState[] = ["empty", "loading", "populated", "error", "permission", "busy", "offline", "boundary"];
// Boundary/scale fixture: many meshes incl. a very long name + overflow badge.
// Ordered so page 0 (4/page) carries the long name — exercises both pagination and
// the truncation treatment on the first page.
const MANY_MESHES: { id: string; status: Status }[] = [
  { id: "dev-mesh", status: "working" },
  { id: "a-very-long-mesh-name-that-should-truncate-gracefully", status: "blocked" },
  { id: "release-candidate-2026-q3", status: "working" },
  { id: "alpha", status: "ready" },
  { id: "beta", status: "blocked" }, { id: "docs-mesh", status: "idle" },
  { id: "staging", status: "ready" }, { id: "infra", status: "idle" },
  { id: "research", status: "working" }, { id: "sandbox", status: "ready" },
  { id: "perf", status: "idle" }, { id: "security-audit", status: "attention" }, { id: "docs-site", status: "ready" },
];
// Left-nav mesh list pages (mirrors Sidebar.tsx PER_PAGE; audit #19).
const NAV_PER_PAGE = 4;

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

// `busy` → ApprovalCard busy (spinner + options disabled); resolved → resolvedLabel.
function ApprovalFixture({ busy = false, resolved }: { busy?: boolean; resolved?: string }) {
  return (
    <ApprovalCard
      title={`${FOCUS_AGENT} · write file`}
      question={<>Allow <b>{FOCUS_AGENT}</b> to write <code className="text-syntax-string">config.json</code>?</>}
      options={[{ id: "allow", label: "Approve", kind: "approve" }, { id: "once", label: "Just once" }, { id: "deny", label: "Deny", kind: "reject" }]}
      onResolve={() => {}}
      busy={busy}
      resolvedLabel={resolved}
    />
  );
}

function ComposerFixture({ disabled = false, busy = false }: { disabled?: boolean; busy?: boolean }) {
  return (
    <Composer
      disabled={disabled}
      toolbar={<Button size="sm" variant="ghost" iconOnly aria-label="attach" disabled={disabled}>📎</Button>}
      actions={<Button size="sm" variant="primary" disabled={disabled} busy={busy}>Send</Button>}
      hint={disabled ? "composer disabled" : "Enter to send · Shift+Enter for newline"}
    >
      <div className="px-1 py-1 text-sm text-text-muted">Message {FOCUS_AGENT}…</div>
    </Composer>
  );
}

function Transcript({ long = false, busy = false, disabled = false }: { long?: boolean; busy?: boolean; disabled?: boolean }) {
  const rows = long ? LONG_TRANSCRIPT : TRANSCRIPT;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((m, i) => <MessageBubble key={i} who={m.who} text={m.text} />)}
      <ApprovalFixture busy={busy || disabled} resolved={undefined} />
    </div>
  );
}

// Non-happy state stand-in inside a titled panel (empty/loading/error); null otherwise.
function runtimeStatePanel(state: ShellState, title: string, emptyTitle: string, emptyDesc: string): ReactNode | null {
  if (state === "empty") return <div data-runtime-state="empty" className="h-full"><PanelFrame title={title} className="h-full"><EmptyState icon={<span className="text-2xl">🫥</span>} title={emptyTitle} description={emptyDesc} /></PanelFrame></div>;
  if (state === "loading") return <div data-runtime-state="loading" className="h-full"><PanelFrame title={title} className="h-full"><div className="flex flex-col gap-3"><Skeleton variant="line" /><Skeleton variant="row" /><Skeleton variant="card" /></div></PanelFrame></div>;
  if (state === "error") return <div data-runtime-state="error" className="h-full"><PanelFrame title={title} className="h-full"><ErrorBanner title="Failed to load" onRetry={() => {}}>The request failed — the shell stays usable.</ErrorBanner></PanelFrame></div>;
  return null;
}
const runtimeNote = (state: ShellState): ReactNode =>
  state === "offline" ? <p className="mb-2 text-xs text-text-muted">显示最近已知内容；连接恢复后自动刷新。</p>
  : state === "permission" ? <p className="mb-2 text-xs text-text-muted">只读浏览；审批 / 发送 / 打断 / 重启需已授权设备。</p>
  : null;

// Board state stand-in (empty/loading/error); caller wraps in its own data-board div.
function boardStatePanel(state: ShellState, title: string, emptyTitle: string, emptyDesc: string): ReactNode | null {
  if (state === "empty") return <PanelFrame title={title} className="h-full"><EmptyState icon={<span className="text-2xl">📋</span>} title={emptyTitle} description={emptyDesc} action={<Button variant="primary">+ Issue</Button>} /></PanelFrame>;
  if (state === "loading") return <PanelFrame title={title} className="h-full"><div className="flex flex-col gap-2"><Skeleton variant="row" /><Skeleton variant="row" /><Skeleton variant="row" /><Skeleton variant="card" /></div></PanelFrame>;
  if (state === "error") return <PanelFrame title={title} className="h-full"><ErrorBanner title="Failed to load board" onRetry={() => {}}>The board snapshot failed — the shell stays usable.</ErrorBanner></PanelFrame>;
  return null;
}
const boardNote = (state: ShellState): ReactNode =>
  state === "offline" ? <p className="mb-1 text-xs text-text-muted">显示最近已知看板；编辑在离线时禁用。</p>
  : state === "permission" ? <p className="mb-1 text-xs text-text-muted">只读；派活 / 状态 / 批量 / 关闭 / 标签 / 指派 需权限。</p>
  : state === "busy" ? <p className="mb-1 inline-flex items-center gap-1.5 text-xs text-text-muted"><Spinner size={12} label="saving" /> 保存中…（CAS 409 → 自动重新对齐）</p>
  : null;
const boardEditable = (state: ShellState) => !(state === "permission" || state === "offline");

// Desktop runtime — overview: all-agent topology/status with approval red-dots.
function RuntimeOverviewDesktop({ focusHref, canvasHref = "#", state = "populated" }: { focusHref: (id: string) => string; canvasHref?: string; state?: ShellState }) {
  const panel = runtimeStatePanel(state, "Topology · 全体 agent", "No agents", "This mesh has no agents yet — start it or add agents.");
  if (panel) return <div data-runtime="overview" className="h-full">{panel}</div>;
  const agents = state === "boundary" ? MANY_AGENTS : AGENTS;
  const pending = agents.reduce((n, a) => n + a.pending, 0);
  const disabled = state === "permission" || state === "offline";
  return (
    <div data-runtime="overview" className="h-full">
      <PanelFrame
        title="Topology · 全体 agent"
        description={`${agents.length} agents · ${pending} 待审批`}
        actions={<Cluster><LinkButton href={canvasHref} label="open topology canvas" dataKey="canvas-open">⤢ 展开</LinkButton><Button size="sm" variant="primary" disabled={disabled} busy={state === "busy"}>Start</Button></Cluster>}
        className="h-full"
      >
        {runtimeNote(state)}
        {/* Runtime ops: start strategy + live add agent / add edge + new-all-sessions (audit #17/#18). */}
        <div data-runtime-ops className="mb-3 flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1 text-xs text-text-muted">start
            <Select defaultValue="resume" disabled={disabled} aria-label="start strategy" className="w-24"><option>resume</option><option>fresh</option></Select>
          </label>
          <Button size="sm" variant="secondary" disabled={disabled} aria-label="add agent">+ agent</Button>
          <Button size="sm" variant="secondary" disabled={disabled} aria-label="add edge">+ edge</Button>
          <Button size="sm" variant="ghost" disabled={disabled} aria-label="new all sessions">new all sessions</Button>
        </div>
        {state === "busy" ? <div className="mb-2 inline-flex items-center gap-2 text-xs text-text-secondary"><Spinner size={12} label="restarting" /> restarting codex-1…</div> : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {agents.map((a) => a.cold ? (
            // Cold/lazy agent: no focus link — expose Wake instead (audit #11).
            <div key={a.id} className="relative flex flex-col items-center gap-1.5 rounded-xl border border-border bg-surface-raised px-4 py-4">
              <StatusChip status={a.status} variant="dot" />
              <span className="max-w-full truncate text-sm font-medium text-text-primary">{a.id}</span>
              <span className="text-xs text-text-muted">cold</span>
              <Button size="sm" variant="secondary" disabled={disabled} aria-label={`wake ${a.id}`}>Wake</Button>
            </div>
          ) : (
            <a key={a.id} href={focusHref(a.id)} className="relative flex flex-col items-center gap-1.5 rounded-xl border border-border bg-surface-raised px-4 py-4 no-underline hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring">
              <StatusChip status={a.status} variant="dot" />
              <span className="max-w-full truncate text-sm font-medium text-text-primary">{a.id}</span>
              <span className="text-xs text-text-muted">{a.status}</span>
              {a.pending ? <span className="absolute -right-1.5 -top-1.5"><Badge count={a.pending} tone="urgent" /></span> : null}
            </a>
          ))}
        </div>
      </PanelFrame>
    </div>
  );
}

// Desktop runtime — focus: header + runtime selectors + context/health + queue +
// transcript (with expanders / load-older / jump) + inline approval + composer.
function RuntimeFocusDesktop({ state = "populated", fullHref = "#" }: { state?: ShellState; fullHref?: string }) {
  const panel = runtimeStatePanel(state, `运行态 · ${FOCUS_AGENT}`, "No messages yet", "Send the first instruction to start the conversation.");
  if (panel) return <div data-runtime="focus" className="h-full">{panel}</div>;
  const disabled = state === "permission" || state === "offline";
  return (
    <div data-runtime="focus" className="flex h-full flex-col">
      <PanelFrame
        title={`运行态 · ${FOCUS_AGENT}`}
        description="focused transcript"
        actions={<Cluster><StatusChip status="working" variant="soft" /><LinkButton href={fullHref} label="enter fullscreen" dataKey="full-enter">⊞ full</LinkButton><Button size="sm" variant="ghost" disabled={disabled} busy={state === "busy"}>Interrupt</Button><Button size="sm" variant="ghost" disabled={disabled}>Restart</Button></Cluster>}
        className="flex-1"
        bodyClassName="flex flex-col gap-3"
        footer={<ComposerFixture disabled={disabled} busy={state === "busy"} />}
      >
        {runtimeNote(state)}
        <RuntimeControls disabled={disabled} busy={state === "busy"} />
        <ContextHealth near={state === "boundary"} />
        <PendingTurnQueue disabled={disabled} />
        <LoadOlderBar />
        <Transcript long={state === "boundary"} busy={state === "busy"} disabled={disabled} />
        <TranscriptExpanders />
        <JumpToBottom disabled={disabled} />
      </PanelFrame>
    </div>
  );
}

// Mobile runtime — agent card list (pending approvals pinned on top).
function RuntimeListMobile({ focusHref, state = "populated" }: { focusHref: (id: string) => string; state?: ShellState }) {
  const panel = runtimeStatePanel(state, "Agents", "No agents", "This mesh has no agents yet.");
  if (panel) return <div data-runtime="overview">{panel}</div>;
  const agents = state === "boundary" ? MANY_AGENTS : AGENTS;
  const pending = agents.filter((a) => a.pending > 0);
  const totalP = agents.reduce((n, a) => n + a.pending, 0);
  const disabled = state === "permission" || state === "offline";
  return (
    <div data-runtime="overview" className="flex flex-col gap-3">
      {runtimeNote(state)}
      {pending.length ? (
        <PanelFrame title={`⚠ 待审批 (${totalP})`}>
          <div className="flex flex-col gap-1">
            {pending.map((a) => (
              <StatusListRow key={a.id} status="attention" title={`${a.id} · 请求写文件`} href={focusHref(a.id)} trailing={<Badge count={a.pending} tone="urgent" />} />
            ))}
          </div>
        </PanelFrame>
      ) : null}
      {/* Runtime ops (mobile, simplified): start strategy + add agent + new-all (audit #17/#18). */}
      <div data-runtime-ops>
        <ActionBar ariaLabel="runtime ops" end={<Button size="sm" variant="ghost" disabled={disabled} aria-label="new all sessions">new all</Button>}>
          <label className="inline-flex items-center gap-1 text-xs text-text-muted">start
            <Select defaultValue="resume" disabled={disabled} aria-label="start strategy" className="w-20"><option>resume</option><option>fresh</option></Select>
          </label>
          <Button size="sm" variant="secondary" disabled={disabled} aria-label="add agent">+ agent</Button>
        </ActionBar>
      </div>
      <PanelFrame title="Agents">
        <div className="flex flex-col gap-1">
          {agents.map((a) => (
            <StatusListRow
              key={a.id}
              status={a.status}
              title={a.id}
              meta={a.cold ? "cold" : a.status}
              href={a.cold ? undefined : focusHref(a.id)}
              trailing={a.cold
                ? <Button size="sm" variant="secondary" disabled={disabled} aria-label={`wake ${a.id}`}>Wake</Button>
                : a.pending ? <Badge count={a.pending} tone="urgent" /> : undefined}
            />
          ))}
        </div>
      </PanelFrame>
    </div>
  );
}

// Mobile runtime — focus: approval pinned ABOVE the transcript, then composer.
function RuntimeFocusMobile({ state = "populated" }: { state?: ShellState }) {
  const panel = runtimeStatePanel(state, `${FOCUS_AGENT}`, "No messages yet", "Send the first instruction.");
  if (panel) return <div data-runtime="focus">{panel}</div>;
  const disabled = state === "permission" || state === "offline";
  return (
    <div data-runtime="focus" className="flex flex-col gap-3">
      <ActionBar ariaLabel={`${FOCUS_AGENT} actions`} end={<Button size="sm" variant="ghost" disabled={disabled} busy={state === "busy"}>Interrupt</Button>}>
        <StatusChip status="working" variant="soft" />
        <span className="text-sm text-text-secondary">{FOCUS_AGENT}</span>
      </ActionBar>
      {runtimeNote(state)}
      <ApprovalFixture busy={state === "busy" || disabled} />
      <RuntimeControls disabled={disabled} busy={state === "busy"} />
      <ContextHealth near={state === "boundary"} />
      <PendingTurnQueue disabled={disabled} />
      <PanelFrame title="Transcript">
        <div className="flex flex-col gap-2">
          <LoadOlderBar />
          {(state === "boundary" ? LONG_TRANSCRIPT : TRANSCRIPT).map((m, i) => <MessageBubble key={i} who={m.who} text={m.text} />)}
          <TranscriptExpanders />
          <JumpToBottom disabled={disabled} />
        </div>
      </PanelFrame>
      <ComposerFixture disabled={disabled} busy={state === "busy"} />
    </div>
  );
}

// Runtime chrome by state: mesh nav stays "rows" (the mesh exists; only agents vary).
function runtimeChromeFor(state: ShellState): ShellChrome {
  switch (state) {
    case "loading": return { connection: "connecting" };
    case "permission": return { mutationsDisabled: true, banner: PermBanner };
    case "offline": return { connection: "offline", mutationsDisabled: true, banner: OfflineBanner };
    default: return {};
  }
}

// Anchor styled like a small ghost button — used for in-mockup navigation between
// runtime sub-views (focus ⇄ full ⇄ canvas) so the deep links are real and clickable.
function LinkButton({ href, children, label, dataKey }: { href: string; children: ReactNode; label?: string; dataKey?: string }) {
  const attrs = dataKey ? { [`data-${dataKey}`]: "" } : {};
  return (
    <a
      href={href}
      aria-label={label}
      {...attrs}
      className="inline-flex items-center gap-1 rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-xs text-text-primary no-underline hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
    >
      {children}
    </a>
  );
}

// Per-agent live runtime selectors: mode / model / effort / kimi-thinking (audit #10).
function RuntimeControls({ disabled = false, busy = false, kimi = true }: { disabled?: boolean; busy?: boolean; kimi?: boolean }) {
  return (
    <div data-runtime-controls className="flex flex-wrap items-center gap-2">
      <label className="inline-flex items-center gap-1 text-xs text-text-muted">mode
        <Select defaultValue="default" disabled={disabled} aria-label="agent mode" className="w-24"><option>default</option><option>plan</option><option>bypass</option></Select>
      </label>
      <label className="inline-flex items-center gap-1 text-xs text-text-muted">model
        <Select defaultValue="(default)" disabled={disabled} aria-label="agent model" className="w-28">{NM_MODELS.map((m) => <option key={m}>{m}</option>)}</Select>
      </label>
      <label className="inline-flex items-center gap-1 text-xs text-text-muted">effort
        <Select defaultValue="medium" disabled={disabled} aria-label="agent effort" className="w-20">{NM_EFFORTS.map((e) => <option key={e}>{e}</option>)}</Select>
      </label>
      {kimi ? (
        <label className="inline-flex items-center gap-1 text-xs text-text-muted">thinking
          <Select defaultValue="on" disabled={disabled} aria-label="kimi thinking" className="w-16"><option>on</option><option>off</option></Select>
        </label>
      ) : null}
      {busy ? <Spinner size={12} label="applying" /> : null}
    </div>
  );
}

// Context / health usage: usage chip + waterline + near-limit warning + silent-stop
// watch badge (audit #12). `near` (boundary) flips it into the near-limit treatment.
function ContextHealth({ near = false }: { near?: boolean }) {
  const pct = near ? 94 : 62;
  return (
    <div data-context-usage className="flex flex-wrap items-center gap-2">
      <StatusChip status={near ? "attention" : "ready"} variant="soft" label={`ctx ${pct}%`} />
      <span className="inline-flex w-28 items-center"><ProgressBar value={pct} max={100} label={`context ${pct}%`} /></span>
      {near ? <span className="text-xs text-warning">接近上限 — 将自动 compact</span> : null}
      <StatusChip status="idle" variant="soft" label="silent-stop watch" />
    </div>
  );
}

// Pending-turn queue: count + prev/next nav + remove (audit #13).
function PendingTurnQueue({ disabled = false }: { disabled?: boolean }) {
  return (
    <div data-queue className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-xs">
      <span className="shrink-0 text-text-muted">queued · {QUEUED_TURNS.length}</span>
      <Button size="sm" variant="ghost" iconOnly aria-label="prev queued" disabled={disabled}>‹</Button>
      <span className="min-w-0 flex-1 truncate text-text-secondary">{QUEUED_TURNS[0].text}</span>
      <Button size="sm" variant="ghost" iconOnly aria-label="next queued" disabled={disabled}>›</Button>
      <Button size="sm" variant="ghost" iconOnly aria-label="remove queued" disabled={disabled}>×</Button>
    </div>
  );
}

// Transcript item expanders: thought / tool input·output·files / long mail (audit #14).
function TranscriptExpanders() {
  return (
    <div data-transcript-expanders className="flex flex-col gap-1.5">
      <details className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-secondary">
        <summary className="cursor-pointer text-text-muted">▸ thought</summary>
        <p className="mt-1">Planning the gate order: tsc → unit → e2e before touching config.json.</p>
      </details>
      <details className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs">
        <summary className="cursor-pointer text-text-muted">▸ tool · write_file (input / output / files)</summary>
        <pre className="mt-1 overflow-x-auto rounded bg-surface-sunken px-2 py-1 font-mono text-text-secondary">{"{ path: \"config.json\", bytes: 184 } → ok"}</pre>
      </details>
      <div className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-secondary">
        <span className="text-text-muted">✉ mail from router — </span>proceed with the gate; ping me before pushing…
        <Button size="sm" variant="ghost" data-mail-expand aria-label="expand mail">expand</Button>
      </div>
    </div>
  );
}

// Top "load older" affordance + bottom "jump to latest" (audit #15).
function LoadOlderBar() {
  return <div className="flex justify-center"><Button size="sm" variant="ghost" data-load-older aria-label="load older">↑ 加载更早</Button></div>;
}
function JumpToBottom({ disabled = false }: { disabled?: boolean }) {
  return <div className="flex justify-end"><Button size="sm" variant="secondary" data-jump-bottom aria-label="jump to bottom" disabled={disabled}>↓ 最新</Button></div>;
}

// Session fullscreen (audit #9) — standalone desktop frame: the conversation pane
// fills the whole frame (no topology/context split); `⊟ exit` restores the split.
function RuntimeFullFrame({ state, backHref }: { state: ShellState; backHref: string }) {
  const disabled = state === "permission" || state === "offline";
  const near = state === "boundary";
  const panel = runtimeStatePanel(state, `运行态 · ${FOCUS_AGENT} · 全屏`, "No messages yet", "Send the first instruction to start the conversation.");
  return (
    <div data-mockup="frame" data-device="desktop" data-runtime="full" className="flex h-[720px] w-[1280px] max-w-full flex-col overflow-hidden rounded-xl border border-border bg-surface text-text-primary shadow-sm">
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        <Brand /><span className="text-text-muted">·</span>
        <span className="text-sm font-semibold">运行态 · {FOCUS_AGENT} · 全屏</span>
        <StatusChip status="working" variant="soft" />
        <span className="flex-1" aria-hidden="true" />
        <RuntimeControls disabled={disabled} busy={state === "busy"} />
        <LinkButton href={backHref} label="exit fullscreen" dataKey="full-exit">⊟ exit</LinkButton>
      </header>
      {state === "permission" ? PermBanner : null}
      {state === "offline" ? OfflineBanner : null}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {panel ? <div className="mx-auto max-w-[900px]">{panel}</div> : (
          <div className="mx-auto flex max-w-[900px] flex-col gap-3">
            {runtimeNote(state)}
            <ContextHealth near={near} />
            <PendingTurnQueue disabled={disabled} />
            <LoadOlderBar />
            <Transcript long={state === "boundary"} busy={state === "busy"} disabled={disabled} />
            <TranscriptExpanders />
            <JumpToBottom disabled={disabled} />
          </div>
        )}
      </div>
      <div className="border-t border-border bg-surface-raised p-3"><ComposerFixture disabled={disabled} busy={state === "busy"} /></div>
    </div>
  );
}

// Zoomable topology canvas (audit #16) — standalone desktop overlay frame: draggable /
// resizable agent windows, per-window stop / wake / actions (⋯), zoom toolbar, Esc close.
function CanvasWindow({ a, index, disabled }: { a: RuntimeAgent; index: number; disabled: boolean }) {
  const left = 16 + (index % 3) * 392;
  const top = 16 + Math.floor(index / 3) * 176;
  return (
    <div
      data-canvas-window
      className="absolute flex w-[372px] flex-col rounded-lg border border-border-strong bg-surface-raised shadow-sm"
      style={{ left, top }}
    >
      <div data-canvas-drag className="flex cursor-move items-center gap-1.5 border-b border-border px-2 py-1.5">
        <StatusChip status={a.status} variant="dot" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{a.id}</span>
        {a.cold
          ? <Button size="sm" variant="secondary" disabled={disabled} aria-label={`wake ${a.id}`}>Wake</Button>
          : <Button size="sm" variant="ghost" iconOnly disabled={disabled} aria-label={`stop ${a.id}`}>■</Button>}
        <Button size="sm" variant="ghost" iconOnly disabled={disabled} aria-label={`${a.id} actions`}>⋯</Button>
      </div>
      <div className="px-2 py-2 text-xs text-text-muted">{a.cold ? "cold — wake to resume" : `${a.status} · ${a.pending} 待审批`}</div>
      <span data-resize-handle aria-hidden="true" className="absolute bottom-0 right-0 cursor-nwse-resize p-1 text-text-muted">⌟</span>
    </div>
  );
}
function MeshCanvasFrame({ state, backHref }: { state: ShellState; backHref: string }) {
  const agents = state === "boundary" ? MANY_AGENTS : AGENTS;
  const disabled = state === "permission" || state === "offline";
  return (
    <div data-mockup="frame" data-device="desktop" data-runtime="canvas" className="flex h-[720px] w-[1280px] max-w-full flex-col overflow-hidden rounded-xl border border-border bg-surface text-text-primary shadow-sm">
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        <Brand /><span className="text-text-muted">·</span>
        <span className="text-sm font-semibold">Topology canvas</span>
        <span className="text-xs text-text-muted">{agents.length} windows · drag / resize</span>
        <span className="flex-1" aria-hidden="true" />
        <Button size="sm" variant="ghost" iconOnly aria-label="zoom out">－</Button>
        <span className="text-xs text-text-muted tabular-nums">100%</span>
        <Button size="sm" variant="ghost" iconOnly aria-label="zoom in">＋</Button>
        <Button size="sm" variant="ghost" aria-label="fit to window">fit</Button>
        <LinkButton href={backHref} label="close canvas" dataKey="canvas-close">Esc 关闭</LinkButton>
      </header>
      {state === "permission" ? PermBanner : null}
      {state === "offline" ? OfflineBanner : null}
      <div data-canvas className="relative min-h-0 flex-1 overflow-auto bg-surface-sunken">
        {agents.map((a, i) => <CanvasWindow key={a.id} a={a} index={i} disabled={disabled} />)}
      </div>
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
function IssueRow({ issue, editable = true }: { issue: Issue; editable?: boolean }) {
  const life = lifeOf(issue.status);
  const terminal = issue.status === "done" || issue.status === "cancelled";
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
      {/* Reopen — the one sanctioned backward move for a closed (terminal) issue (audit #25). */}
      {terminal ? <Button size="sm" variant="ghost" disabled={!editable} aria-label={`reopen #${issue.n}`}>↺ reopen</Button> : null}
      <span className="w-8 shrink-0 text-right text-xs text-text-muted">{issue.updated}</span>
    </div>
  );
}

function EpicGroupHeader({ epicId }: { epicId: string }) {
  const e = MANY_EPICS.find((x) => x.id === epicId)!; // MANY_EPICS ⊇ EPICS (covers boundary)
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface-sunken px-3 py-1.5">
      <span aria-hidden="true" className="text-text-muted">▾</span>
      <span className="text-sm font-medium text-text-primary">Epic: {e.name}</span>
      <span className="text-xs text-text-muted">({e.open} open · {e.closed} closed · subtasks {e.subDone}/{e.subTotal})</span>
    </div>
  );
}

function BoardFilterBar({ disabled = false, manageHref = "#", manage = false }: { disabled?: boolean; manageHref?: string; manage?: boolean }) {
  return (
    <ActionBar
      ariaLabel="board filters"
      end={<Cluster>
        {/* 管理标签 toggle → label CRUD/palette panel (audit #24). */}
        <LinkButton href={manageHref} label="管理标签" dataKey="board-manage-labels">{manage ? "✓ 标签" : "🏷 标签"}</LinkButton>
        <Button size="sm" variant="secondary" disabled={disabled}>Dispatch ▾</Button>
        <Button size="sm" variant="primary" disabled={disabled}>+ Issue</Button>
      </Cluster>}
    >
      <input aria-label="search issues" placeholder="search…" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary placeholder:text-text-muted" />
      <select aria-label="status filter" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary"><option>status</option></select>
      <select aria-label="label filter" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary"><option>label</option></select>
      <select aria-label="assignee filter" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary"><option>assignee</option></select>
      <select aria-label="epic filter" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary"><option>epic</option></select>
      <select aria-label="sort" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary"><option>updated</option></select>
      {/* Group-by-epic toggle (audit #23). */}
      <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary"><input type="checkbox" defaultChecked disabled={disabled} aria-label="group by epic" className="accent-accent" /> 按 Epic 分组</label>
    </ActionBar>
  );
}

// Label CRUD + accessible palette picker (audit #24) — create / rename / recolor / delete.
function PaletteRow({ selected, disabled = false, ariaLabel }: { selected: string; disabled?: boolean; ariaLabel: string }) {
  return (
    <span role="group" aria-label={ariaLabel} data-palette className="inline-flex flex-wrap items-center gap-1">
      {LABEL_PALETTE.map((c) => (
        <button key={c} type="button" disabled={disabled} aria-label={`color ${c}`} aria-pressed={c === selected}
          className={`h-5 w-5 rounded-full border ${c === selected ? "border-border-strong" : "border-border"} disabled:cursor-not-allowed`}
          style={{ background: c }} />
      ))}
    </span>
  );
}
function BoardLabelManager({ disabled = false }: { disabled?: boolean }) {
  return (
    <div data-board-labels className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">管理标签 · 创建 / 重命名 / 改色 / 删除</span>
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="标签名" disabled={disabled} aria-label="new label name" className="w-40" />
        <PaletteRow selected={LABEL_PALETTE[4]} disabled={disabled} ariaLabel="new label color" />
        <Button size="sm" variant="secondary" disabled={disabled} aria-label="add label">+ 添加标签</Button>
      </div>
      <div className="flex flex-col gap-1.5">
        {BOARD_LABELS.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs" style={{ background: l.color, color: labelText(l.color) }}>🏷 {l.name}</span>
            <Input defaultValue={l.name} disabled={disabled} aria-label={`rename ${l.name}`} className="w-32" />
            <PaletteRow selected={l.color} disabled={disabled} ariaLabel={`recolor ${l.name}`} />
            <Button size="sm" variant="ghost" iconOnly disabled={disabled} aria-label={`delete ${l.name}`}>×</Button>
          </div>
        ))}
      </div>
    </div>
  );
}
// Create epic / task inline row (running mesh; audit #25).
function BoardCreateRow({ disabled = false }: { disabled?: boolean }) {
  return (
    <div data-board-create className="flex flex-wrap items-center gap-2">
      <Input placeholder="new task…" disabled={disabled} aria-label="new task" className="w-48" />
      <Input placeholder="new epic…" disabled={disabled} aria-label="new epic" className="w-40" />
      <span className="text-xs text-text-muted">Enter 创建（running mesh）</span>
    </div>
  );
}

// Board fullscreen toggle (audit #22) — 🗖 enter / 🗕 restore the board panel.
function BoardFsToggle({ href, fs }: { href: string; fs: boolean }) {
  return <LinkButton href={href} label={fs ? "退出全屏" : "全屏"} dataKey="board-fs">{fs ? "🗕" : "🗖"}</LinkButton>;
}
// Board fullscreen (audit #22) — the board panel expanded to a standalone desktop frame
// (more rows/cards visible); 🗕 in the subview header restores the split shell.
function BoardFullFrame({ board, state, backHref, manage = false, manageHref = "#" }: { board: BoardState; state: ShellState; backHref: string; manage?: boolean; manageHref?: string }) {
  const sub = board === "detail" ? <BoardDetailDesktop state={state} fs fsHref={backHref} />
    : board === "kanban" ? <BoardKanbanDesktop state={state} fs fsHref={backHref} />
    : <BoardListDesktop state={state} fs fsHref={backHref} manage={manage} manageHref={manageHref} />;
  return (
    <div data-mockup="frame" data-device="desktop" data-board-fs="1" className="flex h-[720px] w-[1280px] max-w-full flex-col overflow-hidden rounded-xl border border-border bg-surface text-text-primary shadow-sm">
      <div className="min-h-0 flex-1 overflow-auto p-3">{sub}</div>
    </div>
  );
}

function BoardBulkToolbar({ disabled = false }: { disabled?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-sunken px-3 py-1.5 text-xs">
      <label className="inline-flex items-center gap-1.5"><input type="checkbox" aria-label="select all" disabled={disabled} className="accent-accent" /> select all</label>
      <span className="text-text-muted">bulk:</span>
      <Button size="sm" variant="ghost" disabled={disabled}>status ▾</Button>
      <Button size="sm" variant="ghost" disabled={disabled}>label ▾</Button>
      <Button size="sm" variant="ghost" disabled={disabled}>epic ▾</Button>
      <Button size="sm" variant="ghost" disabled={disabled}>assignee ▾</Button>
      <Button size="sm" variant="ghost" disabled={disabled}>close</Button>
      <span className="flex-1" aria-hidden="true" />
      <span className="text-text-muted tabular-nums">{openCount} open · {closedCount} closed</span>
    </div>
  );
}

// Desktop board — List (GitHub-Issues maturity).
function BoardListDesktop({ state = "populated", fs = false, fsHref = "#", manage = false, manageHref = "#" }: { state?: ShellState; fs?: boolean; fsHref?: string; manage?: boolean; manageHref?: string }) {
  const panel = boardStatePanel(state, "Board · Issues", "No issues", "Create the first issue or dispatch from runtime.");
  if (panel) return <div data-board="list" className="h-full">{panel}</div>;
  const editable = boardEditable(state);
  const epics = state === "boundary" ? MANY_EPICS : EPICS;
  const issues = state === "boundary" ? MANY_ISSUES : ISSUES;
  return (
    <div data-board="list" className="h-full">
      <PanelFrame title="Board · Issues" actions={<Cluster><BoardFsToggle href={fsHref} fs={fs} /><SegmentedControl ariaLabel="Board view" value="list" onChange={() => {}} size="sm" options={[{ value: "list", label: "List" }, { value: "kanban", label: "Board" }]} /></Cluster>} className="h-full" bodyClassName="flex flex-col gap-2">
        {boardNote(state)}
        <BoardFilterBar disabled={!editable} manage={manage} manageHref={manageHref} />
        {manage ? <BoardLabelManager disabled={!editable} /> : null}
        <BoardCreateRow disabled={!editable} />
        <BoardBulkToolbar disabled={!editable} />
        <div className="flex flex-col gap-2">
          {epics.map((e) => (
            <div key={e.id} className="flex flex-col">
              <EpicGroupHeader epicId={e.id} />
              {issues.filter((i) => i.epic === e.id).map((i) => <IssueRow key={i.n} issue={i} editable={editable} />)}
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
function BoardDetailDesktop({ state = "populated", fs = false, fsHref = "#" }: { state?: ShellState; fs?: boolean; fsHref?: string }) {
  const panel = boardStatePanel(state, "Issue", "No issue selected", "Pick an issue from the list to see its detail.");
  if (panel) return <div data-board="detail" className="h-full">{panel}</div>;
  const boundary = state === "boundary";
  const it = boundary ? DETAIL_BOUNDARY : DETAIL_ISSUE;
  const timeline = boundary ? BOUNDARY_TIMELINE : TIMELINE;
  const editable = boardEditable(state);
  const terminal = it.status === "done" || it.status === "cancelled";
  return (
    <div data-board="detail" className="h-full">
      <PanelFrame
        title={<span><a href="/__ui-mockup?surface=board&board=list" className="text-link no-underline">◀</a> #{it.n} · {it.title}</span>}
        actions={<Cluster><BoardFsToggle href={fsHref} fs={fs} /><StatusChip status={lifeOf(it.status).status} variant="soft" label={it.status} />{terminal ? <Button size="sm" variant="secondary" disabled={!editable} aria-label={`reopen #${it.n}`}>↺ reopen</Button> : <Button size="sm" variant="secondary" disabled={!editable} busy={state === "busy"}>close ▾</Button>}</Cluster>}
        className="h-full"
        bodyClassName="flex flex-col gap-3"
      >
        {boardNote(state)}
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
          <span>by router · opened {boundary ? "12d" : "3d"}</span><span aria-hidden="true">·</span>
          <AssigneeTag name={it.assignee} size="sm" />
          {it.labels.map((l) => <LabelChip key={l} name={l} />)}
          <span aria-hidden="true">·</span><span>epic: {boundary ? "Infrastructure" : "Onboarding"}</span>
          <span aria-hidden="true">·</span><PrioTag prio={it.prio} />
        </div>
        <LifecyclePath current={it.status} />
        <p className="text-sm text-text-primary">{boundary ? BOUNDARY_BODY : "Add the device-code authorization page so a new browser can enroll and reach the console. Markdown body…"}</p>
        <div className="flex items-center gap-2 text-sm"><span className="text-text-muted">subtasks</span><SubtaskProgress done={it.subDone} total={it.subTotal} /></div>
        {boundary ? (
          <ul className="flex flex-col gap-0.5 text-xs text-text-secondary">
            {BOUNDARY_SUBTASKS.map((s, i) => <li key={i}>{i < it.subDone ? "▣" : "▢"} {s}</li>)}
          </ul>
        ) : null}
        <div className="text-sm"><span className="text-text-muted">deps:</span> {boundary ? <span>blocked-by {BOUNDARY_DEPS.map((d, i) => <span key={i} className={d.includes("⛔") ? "text-danger" : "text-text-primary"}>{i > 0 ? ", " : ""}{d}</span>)}</span> : <span>blocked-by <span className="text-danger">#9 (⛔ open)</span></span>}</div>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-text-muted">activity timeline</div>
          <ul className="flex flex-col gap-2">
            {timeline.map((t, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span aria-hidden="true" className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${t.kind === "lifecycle" ? "bg-accent" : "bg-border-strong"}`} />
                <span className="flex-1 text-text-primary">{t.text}</span>
                <span className="text-xs text-text-muted">{t.when}</span>
              </li>
            ))}
          </ul>
        </div>
        <Composer disabled={!editable} actions={<Button size="sm" variant="primary" disabled={!editable}>Comment</Button>} hint={editable ? "markdown supported" : "comments disabled"}><div className="px-1 py-1 text-sm text-text-muted">Leave a comment…</div></Composer>
        <ActionBar ariaLabel="issue controls"><Button size="sm" variant="ghost" disabled={!editable}>status ▾</Button><Button size="sm" variant="ghost" disabled={!editable}>assignee ▾</Button><Button size="sm" variant="ghost" disabled={!editable}>labels ▾</Button><Button size="sm" variant="ghost" disabled={!editable}>epic ▾</Button><Button size="sm" variant="ghost" disabled={!editable}>deps ▾</Button></ActionBar>
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
function BoardKanbanDesktop({ state = "populated", fs = false, fsHref = "#" }: { state?: ShellState; fs?: boolean; fsHref?: string }) {
  const panel = boardStatePanel(state, "Board · Kanban", "No issues", "Create the first issue or dispatch from runtime.");
  if (panel) return <div data-board="kanban" className="h-full">{panel}</div>;
  const issues = state === "boundary" ? MANY_ISSUES : ISSUES;
  return (
    <div data-board="kanban" className="h-full">
      <PanelFrame title="Board · Kanban" description="swimlanes: epic ▾ · drag = set_status (perm-gated)" actions={<Cluster><BoardFsToggle href={fsHref} fs={fs} /><SegmentedControl ariaLabel="Board view" value="kanban" onChange={() => {}} size="sm" options={[{ value: "list", label: "List" }, { value: "kanban", label: "Board" }]} /></Cluster>} className="h-full">
        {boardNote(state)}
        <div className="flex gap-3 overflow-x-auto pb-2">
          {LIFECYCLE.map((col) => {
            const cards = issues.filter((i) => i.status === col.id);
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

function BoardListMobile({ state = "populated" }: { state?: ShellState }) {
  const panel = boardStatePanel(state, "Issues", "No issues", "Create the first issue.");
  if (panel) return <div data-board="list">{panel}</div>;
  const editable = boardEditable(state);
  const issues = state === "boundary" ? MANY_ISSUES : ISSUES;
  const open = issues.filter((i) => i.status !== "done" && i.status !== "cancelled").length;
  return (
    <div data-board="list" className="flex flex-col gap-3">
      {boardNote(state)}
      <ActionBar ariaLabel="board filters" end={<Button size="sm" variant="primary" disabled={!editable}>+ Issue</Button>}>
        <input aria-label="search issues" placeholder="search…" className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary placeholder:text-text-muted" />
        <select aria-label="status filter" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary"><option>status</option></select>
      </ActionBar>
      {/* Group-by-epic toggle (audit #23) — in the mobile filter row (△ filter sheet). */}
      <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary"><input type="checkbox" defaultChecked disabled={!editable} aria-label="group by epic" className="accent-accent" /> 按 Epic 分组</label>
      <PanelFrame title={`Issues · ${open} open`}>
        <div className="flex flex-col gap-2">
          {issues.map((i) => <MobileIssueCard key={i.n} issue={i} />)}
        </div>
      </PanelFrame>
    </div>
  );
}

function BoardDetailMobile({ state = "populated" }: { state?: ShellState }) {
  const panel = boardStatePanel(state, "Issue", "No issue selected", "Pick an issue from the list.");
  if (panel) return <div data-board="detail">{panel}</div>;
  const boundary = state === "boundary";
  const it = boundary ? DETAIL_BOUNDARY : DETAIL_ISSUE;
  const timeline = boundary ? BOUNDARY_TIMELINE : TIMELINE;
  const editable = boardEditable(state);
  return (
    <div data-board="detail" className="flex flex-col gap-3">
      {boardNote(state)}
      <ActionBar ariaLabel={`#${it.n} controls`} end={<Button size="sm" variant="secondary" disabled={!editable} busy={state === "busy"}>close ▾</Button>}>
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
        {boundary ? <p className="mt-2 text-sm text-text-primary">{BOUNDARY_BODY}</p> : null}
        <div className="mt-2 flex items-center gap-2 text-sm"><span className="text-text-muted">subtasks</span><SubtaskProgress done={it.subDone} total={it.subTotal} /></div>
        {boundary ? <div className="mt-1 text-xs text-text-secondary">deps: blocked-by {BOUNDARY_DEPS.join(", ")}</div> : null}
      </PanelFrame>
      <PanelFrame title="Activity">
        <ul className="flex flex-col gap-2">
          {timeline.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span aria-hidden="true" className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${t.kind === "lifecycle" ? "bg-accent" : "bg-border-strong"}`} />
              <span className="flex-1 text-text-primary">{t.text}</span>
              <span className="text-xs text-text-muted">{t.when}</span>
            </li>
          ))}
        </ul>
      </PanelFrame>
      <Composer disabled={!editable} actions={<Button size="sm" variant="primary" disabled={!editable}>Comment</Button>}><div className="px-1 py-1 text-sm text-text-muted">Leave a comment…</div></Composer>
    </div>
  );
}

// ── Mesh Assistant (05) — central NL controller chat (create/manage/delete meshes) ──
// Statuses mirror store.ts assistant scope: absent → "not configured"; starting →
// spawning; ready → chat. Tool-call cards = create_mesh/delete_mesh/update_mesh.
const ASSISTANT_SUGGESTIONS = [
  "创建一个 mesh：router + codex 跑 ~/projects/app",
  "删除 scratch mesh",
  "把 router 的 project 改成 ~/projects/web",
];
const ASSISTANT_TOOL = { tool: "create_mesh", args: "name: app · agents: [router(claude), codex-1(codex)] · edges: router→codex-1", result: "mesh “app” created — start it from 运行态", status: "done" as Status };
const ASSISTANT_TOOLS_MANY = [
  ASSISTANT_TOOL,
  { tool: "get_mesh", args: "name: scratch", result: "router(project=test_mesh_0), 1 edge", status: "done" as Status },
  { tool: "update_mesh", args: "scratch · router.project → test_mesh_web", result: "updated; restart to apply", status: "done" as Status },
  { tool: "delete_mesh", args: "name: scratch-del", result: "awaiting confirm", status: "attention" as Status },
];

function AssistantBubble({ who, text }: { who: "user" | "agent"; text: string }) {
  const mine = who === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm text-text-primary ${mine ? "bg-accent-subtle" : "border border-border bg-surface-raised"}`}>
        <div className="mb-0.5 text-xs text-text-muted">{mine ? "you" : "Mesh Assistant"}</div>
        {text}
      </div>
    </div>
  );
}

// Tool-call card: create/delete/update/get-mesh action + args + result (audit checklist).
function AssistantToolCard({ tool, args, result, status, busy = false }: { tool: string; args: string; result: string; status: Status; busy?: boolean }) {
  return (
    <div data-assistant-tool className="rounded-lg border border-border bg-surface-raised px-3 py-2">
      <div className="flex items-center gap-2">
        <StatusChip status={busy ? "working" : status} variant="dot" />
        <span className="font-mono text-xs text-text-secondary">⚙ {tool}</span>
        <span className="flex-1" aria-hidden="true" />
        {busy ? <Spinner size={12} label="running" /> : <span className="text-xs text-text-muted">{status}</span>}
      </div>
      <pre className="mt-1 overflow-x-auto rounded bg-surface-sunken px-2 py-1 text-xs font-mono text-text-secondary">{args}</pre>
      <div className="mt-1 text-xs text-text-secondary">→ {result}</div>
    </div>
  );
}

// Inline confirm card for a destructive assistant action (delete mesh) → ApprovalCard.
function AssistantDeleteConfirm({ busy = false }: { busy?: boolean }) {
  return (
    <ApprovalCard
      title="Mesh Assistant · delete mesh"
      question={<>Delete mesh <code className="text-syntax-string">scratch-del</code>? This removes its config.</>}
      options={[{ id: "del", label: "Delete", kind: "reject" }, { id: "cancel", label: "Cancel" }]}
      onResolve={() => {}}
      busy={busy}
    />
  );
}

function AssistantComposer({ disabled = false, busy = false, imageEnabled = true }: { disabled?: boolean; busy?: boolean; imageEnabled?: boolean }) {
  return (
    <Composer
      disabled={disabled}
      toolbar={<Button size="sm" variant="ghost" iconOnly aria-label={imageEnabled ? "attach image" : "image not advertised"} disabled={disabled || !imageEnabled} title={imageEnabled ? "attach image" : "Mesh Assistant 未声明图片输入"}>📎</Button>}
      actions={<Button size="sm" variant="primary" disabled={disabled} busy={busy}>Send</Button>}
      hint={disabled ? "assistant 不可用" : "Enter 发送 · 用自然语言创建 / 修改 / 删除 mesh"}
    >
      <div className="px-1 py-1 text-sm text-text-muted">让 Mesh Assistant 管理 mesh…</div>
    </Composer>
  );
}

// The Mesh Assistant surface — a standalone full-width chat frame (route /assistant,
// in 管理▾ / mobile 更多). `fs` is the chat fullscreen toggle (audit #21, desktop).
function AssistantFrame({ state, device, fs = false, fsHref = "#" }: { state: ShellState; device: Device; fs?: boolean; fsHref?: string }) {
  const mobile = device === "mobile";
  const absent = state === "error";                       // error column = absent → "not configured"
  const offline = state === "offline";
  const perm = state === "permission";
  const working = state === "busy";
  const disabled = absent || offline || perm || working || state === "loading";
  const imageEnabled = !perm;                             // image attach gated by capability (perm illustrates the gated case)
  const statusChip = absent ? <StatusChip status="blocked" variant="soft" label="not configured" />
    : state === "loading" ? <StatusChip status="working" variant="soft" label="spawning…" />
    : offline ? <StatusChip status="blocked" variant="soft" label="offline" />
    : <StatusChip status="ready" variant="soft" label="ready" />;
  const long = state === "boundary";
  const showChat = !absent && state !== "loading";
  return (
    <div data-mockup="frame" data-device={device} data-assistant="chat" data-assistant-fs={fs ? "1" : undefined}
      className={`flex ${mobile ? "h-[760px] w-[390px] rounded-[28px]" : fs ? "h-[760px] w-[1280px] rounded-xl" : "h-[640px] w-[1280px] rounded-xl"} max-w-full flex-col overflow-hidden border border-border bg-surface text-text-primary shadow-sm`}>
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        <Brand /><span className="text-text-muted">·</span>
        <span className="text-sm font-semibold">Mesh Assistant</span>
        {statusChip}
        <span className="flex-1" aria-hidden="true" />
        {/* p2p DM → Mesh Assistant is folded here (device-auth ⑤ / channels). */}
        <LinkButton href="#" label="p2p DM 入口" dataKey="assistant-p2p">✉ p2p DM</LinkButton>
        {working ? <Button size="sm" variant="ghost" aria-label="interrupt assistant">Interrupt</Button> : null}
        {!mobile ? <LinkButton href={fsHref} label={fs ? "退出全屏" : "全屏"} dataKey="assistant-fs">{fs ? "⊟" : "⊞"}</LinkButton> : null}
      </header>
      {perm ? <div role="status" className="border-b border-border bg-danger-subtle px-4 py-1.5 text-xs text-danger">设备未授权 — 只读；启用 / 管理需已授权设备。</div> : null}
      {offline ? <div role="status" className="flex items-center gap-2 border-b border-border bg-warning-subtle px-4 py-1.5 text-xs text-warning"><Spinner size={12} label="reconnecting" /> 连接已断开 — 正在重连…（显示最近已知对话）</div> : null}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className={`mx-auto flex flex-col gap-3 ${mobile ? "" : "max-w-[820px]"}`}>
          {absent ? (
            <EmptyState icon={<span className="text-2xl">🤖</span>} title="Mesh Assistant 未配置" description="未检测到 assistant harness — 启用后即可用自然语言管理 mesh。" action={<Button variant="primary">启用助手</Button>} />
          ) : state === "loading" ? (
            <div className="flex flex-col gap-3"><Skeleton variant="line" /><Skeleton variant="row" /><Skeleton variant="card" /></div>
          ) : state === "empty" ? (
            <>
              <AssistantBubble who="agent" text="我是 Mesh Assistant — 告诉我你想怎么编排 mesh。" />
              <div data-assistant-suggestions className="flex flex-col gap-2">
                <span className="text-xs uppercase tracking-wider text-text-muted">试试：</span>
                <div className="flex flex-wrap gap-2">{ASSISTANT_SUGGESTIONS.map((s, i) => <button key={i} className="rounded-full border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-secondary hover:bg-hover">{s}</button>)}</div>
              </div>
            </>
          ) : (
            <>
              {offline ? <p className="text-xs text-text-muted">显示最近已知对话；连接恢复后自动刷新。</p> : null}
              <AssistantBubble who="user" text="create a mesh named app with a router and a codex member on ~/projects/app" />
              <AssistantBubble who="agent" text="Creating mesh “app” with router (claude) + codex-1 (codex)…" />
              <AssistantToolCard {...ASSISTANT_TOOL} busy={working} />
              {long ? ASSISTANT_TOOLS_MANY.map((tc, i) => <AssistantToolCard key={i} {...tc} />) : null}
              <AssistantBubble who="agent" text="Done — mesh “app” created. Start it from the runtime view." />
              <AssistantBubble who="user" text="now delete the scratch-del mesh" />
              <AssistantDeleteConfirm busy={working || disabled} />
            </>
          )}
        </div>
      </div>
      {showChat ? <div className="border-t border-border bg-surface-raised p-3"><AssistantComposer disabled={disabled} busy={working} imageEnabled={imageEnabled} /></div> : null}
    </div>
  );
}

// ── Harnesses (06) — adapter install / health / version / old-version restarts ──────
// Mirrors HarnessPanel.tsx: HARNESS_COMMANDS (adapter · tool), statusLabel kinds
// (ok/warn/bad/off), InstallProgress, SelfInstallerGuide, OldVersionAgents respawn.
type HarnessKind = "ok" | "warn" | "bad" | "off";
const HARNESS_TONE: Record<HarnessKind, Status> = { ok: "ready", warn: "attention", bad: "blocked", off: "idle" };
interface HarnessRowData { id: string; label: string; line: string; kind: HarnessKind; statusText: string; auth?: boolean; selfInstall?: boolean }
const HARNESS_ROWS: HarnessRowData[] = [
  { id: "claude", label: "Claude", line: "claude-agent-acp 1.4.2 · claude 0.141.0", kind: "ok", statusText: "installed v1.4.2" },
  { id: "codex", label: "Codex", line: "codex-acp 1.2.3 · codex 0.140.0", kind: "warn", statusText: "update available — v1.2.3 → v1.2.5", auth: true },
  { id: "opencode", label: "OpenCode", line: "opencode —", kind: "bad", statusText: "missing — install required", selfInstall: true },
  { id: "kimi", label: "Kimi", line: "kimi —", kind: "off", statusText: "installed; version unknown", selfInstall: true },
];
const INSTALL_LINES = ["$ npm i -g codex-acp@1.2.5", "added 1 package in 3.2s", "codex-acp@1.2.5 → ready"];
const INSTALL_LINES_LONG = Array.from({ length: 9 }, (_, i) => INSTALL_LINES[i % INSTALL_LINES.length]).concat(["postinstall: probing tool…", "codex 0.141.0 detected", "done"]);
interface OldAgent { mesh: string; agent: string; from: string; pending: boolean }
const OLD_AGENTS: OldAgent[] = [
  { mesh: "dev-mesh", agent: "codex-1", from: "codex-acp 1.2.3", pending: false },
  { mesh: "alpha", agent: "claude-1", from: "claude-agent-acp 1.4.0", pending: true },
];
const OLD_AGENTS_MANY: OldAgent[] = [
  ...OLD_AGENTS,
  { mesh: "beta", agent: "codex-2", from: "codex-acp 1.2.3", pending: false },
  { mesh: "docs-mesh", agent: "claude-2", from: "claude-agent-acp 1.4.0", pending: false },
  { mesh: "infra", agent: "codex-3", from: "codex-acp 1.2.1", pending: true },
  { mesh: "research", agent: "claude-3", from: "claude-agent-acp 1.3.9", pending: false },
];

// Self-install guide for npm-locked harnesses: copy command + docs + reprobe-to-detect (audit #27).
function SelfInstallerGuide({ id, command, disabled = false }: { id: string; command: string; disabled?: boolean }) {
  return (
    <div data-self-installer className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-xs">
      <span className="text-text-muted">自助安装：</span>
      <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-text-secondary">{command}</code>
      <Button size="sm" variant="ghost" disabled={disabled} aria-label={`copy install command for ${id}`}>copy command</Button>
      <Button size="sm" variant="ghost" disabled={disabled} aria-label={`open ${id} docs`}>docs ↗</Button>
      <Button size="sm" variant="ghost" disabled={disabled} aria-label={`reprobe ${id}`}>reprobe to detect</Button>
    </div>
  );
}

// One harness row: status + dual version + auth + reprobe + install/update (or self-install).
function HarnessRow({ row, disabled = false }: { row: HarnessRowData; disabled?: boolean }) {
  return (
    <div data-harness-row className="flex flex-col gap-1 border-b border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={HARNESS_TONE[row.kind]} variant="dot" />
        <span className="text-sm font-medium text-text-primary">{row.label}</span>
        <StatusChip status={HARNESS_TONE[row.kind]} variant="soft" label={row.statusText} />
        {row.auth ? <StatusChip status="attention" variant="soft" label="auth required" /> : null}
        <span className="flex-1" aria-hidden="true" />
        <Button size="sm" variant="ghost" disabled={disabled} aria-label={`reprobe ${row.id}`}>reprobe</Button>
        {/* npm install/update only for missing(bad)/outdated(warn); installed-ok shows none. */}
        {!row.selfInstall && (row.kind === "bad" || row.kind === "warn") ? <Button size="sm" variant="secondary" disabled={disabled} aria-label={`${row.kind === "warn" ? "update" : "install"} ${row.id}`}>{row.kind === "warn" ? "update" : "install"}</Button> : null}
      </div>
      <div className="truncate font-mono text-xs text-text-muted">{row.line}</div>
      {row.selfInstall ? <SelfInstallerGuide id={row.id} command={`npm i -g ${row.id}`} disabled={disabled} /> : null}
    </div>
  );
}

// Live install progress: streamed log + retry-a-dropped-stream + close-on-done (audit #26).
function InstallProgressCard({ status, long = false }: { status: "running" | "done" | "error" | "interrupted"; long?: boolean }) {
  const live = status === "running" ? "Installing codex-acp@1.2.5…" : status === "done" ? "Installed codex-acp v1.2.5" : status === "interrupted" ? "stream interrupted, click to retry" : "install failed — npm registry unreachable";
  return (
    <div data-install-progress className={`flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3`}>
      <div className="flex items-center gap-2">
        <StatusChip status={status === "running" ? "working" : status === "done" ? "done" : status === "interrupted" ? "attention" : "blocked"} variant="dot" />
        <span className="text-sm text-text-primary">{live}</span>
        <span className="flex-1" aria-hidden="true" />
        {status === "running" ? <Spinner size={12} label="installing" /> : null}
        {status === "interrupted" ? <Button size="sm" variant="primary" aria-label="retry stream">retry stream</Button> : null}
        {status !== "running" ? <Button size="sm" variant="ghost" aria-label="close install progress">close</Button> : null}
      </div>
      <pre className="max-h-40 overflow-auto rounded bg-surface px-2 py-1.5 text-xs font-mono text-text-secondary">{(long ? INSTALL_LINES_LONG : INSTALL_LINES).join("\n")}</pre>
    </div>
  );
}

// Agents still on an older adapter — restart after-idle / force (two-click) / cancel (audit #28).
function OldVersionAgentsCard({ rows, disabled = false }: { rows: OldAgent[]; disabled?: boolean }) {
  return (
    <div data-old-agents className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">旧版本 agent · 重启以采用新适配器 ({rows.length})</span>
      <div className="flex flex-col gap-1.5">
        {rows.map((a) => {
          const entry = `${a.mesh}/${a.agent}`;
          return (
            <div key={entry} className="flex flex-wrap items-center gap-2 text-sm">
              <StatusChip status={a.pending ? "working" : "attention"} variant="dot" />
              <span className="font-medium text-text-primary">{entry}</span>
              <span className="font-mono text-xs text-text-muted">{a.from}</span>
              <span className="flex-1" aria-hidden="true" />
              {a.pending ? (
                <>
                  <span className="text-xs text-text-muted">restart pending…</span>
                  <Button size="sm" variant="ghost" disabled={disabled} aria-label={`cancel restart ${entry}`}>cancel</Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="secondary" disabled={disabled} aria-label={`restart ${entry} after idle`}>after current turn</Button>
                  <ConfirmButton size="sm" variant="danger" disabled={disabled} aria-label={`force restart ${entry}`} confirmLabel="确认?（丢失 ACP 会话）" onConfirm={() => {}}>force</ConfirmButton>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HarnessesFrame({ state, device }: { state: ShellState; device: Device }) {
  const mobile = device === "mobile";
  const disabled = state === "permission" || state === "offline";
  const loading = state === "loading";
  const oldAgents = state === "boundary" ? OLD_AGENTS_MANY : OLD_AGENTS;
  const installCard: ReactNode = state === "busy" ? <InstallProgressCard status="running" />
    : state === "error" ? <InstallProgressCard status="interrupted" />
    : state === "boundary" ? <InstallProgressCard status="done" long />
    : state === "populated" ? <InstallProgressCard status="done" />
    : null;
  return (
    <div data-mockup="frame" data-device={device} data-harnesses="panel"
      className={`flex ${mobile ? "h-[760px] w-[390px] rounded-[28px]" : "h-[680px] w-[1280px] rounded-xl"} max-w-full flex-col overflow-hidden border border-border bg-surface text-text-primary shadow-sm`}>
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        <Brand /><span className="text-text-muted">·</span>
        <span className="text-sm font-semibold">Harnesses</span>
        {disabled ? <StatusChip status="blocked" variant="soft" label={state === "offline" ? "offline" : "未授权"} /> : null}
        <span className="flex-1" aria-hidden="true" />
        <Button size="sm" variant="ghost" disabled={disabled} aria-label="refresh harness status">refresh</Button>
      </header>
      {state === "permission" ? <div role="status" className="border-b border-border bg-danger-subtle px-4 py-1.5 text-xs text-danger">安装 / 重启为宿主端操作 — 需已授权设备。</div> : null}
      {state === "offline" ? <div role="status" className="flex items-center gap-2 border-b border-border bg-warning-subtle px-4 py-1.5 text-xs text-warning"><Spinner size={12} label="reconnecting" /> 连接已断开 — 正在重连…（显示最近已知状态，操作禁用）</div> : null}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className={`mx-auto flex flex-col gap-4 ${mobile ? "" : "max-w-[860px]"}`}>
          {state === "error" ? <ErrorBanner title="Probe failed" onRetry={() => {}}>无法探测部分 harness — 注册表不可达；其余功能仍可用。</ErrorBanner> : null}
          <div className="flex flex-col rounded-lg border border-border bg-surface-raised">
            {loading
              ? [0, 1, 2, 3].map((i) => <div key={i} className="border-b border-border px-3 py-2.5"><div className="flex items-center gap-2"><StatusChip status="idle" variant="dot" /><span className="text-sm text-text-muted">loading status…</span></div><div className="mt-1"><Skeleton variant="line" /></div></div>)
              : HARNESS_ROWS.map((r) => <HarnessRow key={r.id} row={r} disabled={disabled} />)}
          </div>
          {installCard}
          {!loading ? <OldVersionAgentsCard rows={oldAgents} disabled={disabled} /> : null}
        </div>
      </div>
    </div>
  );
}

// ── Channels (07) — Feishu connection / chat→mesh binding / sender allowlist ─────────
// Mirrors src/channels: FeishuChannelStatus (state disabled/running/stopped/error +
// configured/enabled/appId/domain/bindings), FeishuMeshBinding (mesh/chatId/name/source/
// requireMention/allowSenders), provision job (starting/waiting[QR]/complete/cancelled/
// error), and the device-auth allowSenders allowlist (auth-code enrollment → approve/revoke).
const FEISHU = { appId: "cli_a1b2c3d4", domain: "feishu" as const, configPath: "channels/feishu.json" };
interface ChannelBinding { mesh: string; chatId: string; name: string; source: "manual" | "auto"; requireMention: boolean }
const CH_BINDINGS: ChannelBinding[] = [
  { mesh: "dev-mesh", chatId: "oc_9f…a1", name: "dev-mesh@host", source: "auto", requireMention: true },
  { mesh: "ops", chatId: "oc_3e…b7", name: "ops@host", source: "manual", requireMention: false },
];
interface PendingSender { openId: string; authcode: string; when: string }
const CH_PENDING: PendingSender[] = [
  { openId: "ou_77c…e2", authcode: "AB12-CD34", when: "2m" },
  { openId: "ou_5a1…9f", authcode: "EF56-GH78", when: "8m" },
];
interface AuthSender { openId: string; label: string }
const CH_AUTHORIZED: AuthSender[] = [
  { openId: "ou_me…01", label: "you (operator)" },
  { openId: "ou_22b…7c", label: "teammate" },
];
const CH_BINDINGS_MANY: ChannelBinding[] = [
  ...CH_BINDINGS,
  { mesh: "infra", chatId: "oc_aa…22", name: "infra@host", source: "auto", requireMention: true },
  { mesh: "research", chatId: "oc_bb…33", name: "research@host", source: "manual", requireMention: false },
  { mesh: "security-audit", chatId: "oc_cc…44", name: "security@host", source: "auto", requireMention: true },
];
const CH_PENDING_MANY: PendingSender[] = [
  ...CH_PENDING,
  { openId: "ou_91d…3a", authcode: "IJ90-KL12", when: "11m" },
  { openId: "ou_44e…6b", authcode: "MN34-OP56", when: "20m" },
  { openId: "ou_88f…0c", authcode: "QR78-ST90", when: "33m" },
];
const CH_AUTHORIZED_MANY: AuthSender[] = [
  ...CH_AUTHORIZED,
  { openId: "ou_33c…1d", label: "reviewer" }, { openId: "ou_77a…9e", label: "ops-bot" },
  { openId: "ou_55b…2f", label: "oncall" }, { openId: "ou_99d…4a", label: "guest" },
];

const FEISHU_STATE: Record<ShellState, { tone: Status; label: string }> = {
  empty: { tone: "idle", label: "not configured" },
  loading: { tone: "working", label: "fetching…" },
  populated: { tone: "ready", label: "running" },
  error: { tone: "blocked", label: "config invalid" },
  permission: { tone: "ready", label: "running" },
  busy: { tone: "working", label: "binding…" },
  offline: { tone: "blocked", label: "offline (stale)" },
  boundary: { tone: "ready", label: "running" },
};

function ChannelStatusCard({ state }: { state: ShellState }) {
  const s = FEISHU_STATE[state];
  return (
    <div data-channel-status className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-raised p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-text-primary">飞书 Feishu</span>
        <StatusChip status={s.tone} variant="soft" label={s.label} />
        {state !== "empty" ? <StatusChip status="idle" variant="soft" label={`domain: ${FEISHU.domain}`} /> : null}
        <span className="flex-1" aria-hidden="true" />
        <code className="font-mono text-xs text-text-muted">{FEISHU.configPath}</code>
      </div>
      {state === "empty"
        ? <p className="text-xs text-text-muted">未配置 — 在 <code className="font-mono">channels/feishu.json</code> 填入 appId/appSecret/bot 后 reload 启用。</p>
        : state === "error"
        ? <p className="text-xs text-danger">配置无效 — appSecret 缺失或 bot scope 不足；修正后 reload。</p>
        : <p className="text-xs text-text-muted">appId {FEISHU.appId} · 入站事件 + 出站 IM · allowSenders 白名单门禁开启。</p>}
    </div>
  );
}

// Provision flow card (bind chat → mesh): waiting = QR + verify url + cancel (audit checklist).
function ProvisionCard({ disabled = false }: { disabled?: boolean }) {
  return (
    <div data-provision className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded border border-border-strong bg-surface text-3xl" aria-label="授权二维码">▦</div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm text-text-primary">在飞书中扫码授权（waiting）</span>
        <a href="#" className="truncate text-xs text-link no-underline">https://open.feishu.cn/…/verify?token=…</a>
        <span className="text-xs text-text-muted">过期：04:32 · 轮询中…</span>
      </div>
      <Button size="sm" variant="ghost" disabled={disabled} aria-label="cancel provision">取消</Button>
    </div>
  );
}

function ChannelBindingsCard({ state, mobile }: { state: ShellState; mobile: boolean }) {
  const disabled = state === "permission" || state === "offline";
  const busy = state === "busy";
  const bindings = state === "empty" ? [] : state === "boundary" ? CH_BINDINGS_MANY : CH_BINDINGS;
  return (
    <div data-bindings className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-text-muted">绑定 chat → mesh ({bindings.length})</span>
        <Cluster>
          <Button size="sm" variant="ghost" disabled={disabled} aria-label="sync feishu groups">sync</Button>
          <Button size="sm" variant="secondary" disabled={disabled} aria-label="bind chat to mesh">+ 绑定</Button>
        </Cluster>
      </div>
      {state === "error" ? <ErrorBanner title="Bind failed" onRetry={() => {}}>provision 失败 — 稍后重试。</ErrorBanner> : null}
      {busy ? <ProvisionCard disabled={disabled} /> : null}
      {bindings.length === 0 && !busy ? <span className="text-xs text-text-muted">暂无绑定。</span> : (
        <div className="flex flex-col gap-1.5">
          {bindings.map((b) => (
            <div key={b.mesh} className="flex flex-wrap items-center gap-2 text-sm">
              <StatusChip status="ready" variant="dot" />
              <span className="font-medium text-text-primary">{b.mesh}</span>
              <span aria-hidden="true" className="text-text-muted">←</span>
              <code className="font-mono text-xs text-text-muted">{b.chatId}</code>
              <span className="text-xs text-text-muted">{b.name}</span>
              <StatusChip status="idle" variant="soft" label={b.source} />
              {b.requireMention ? <span className="text-xs text-text-muted">@mention</span> : null}
              <span className="flex-1" aria-hidden="true" />
              <Button size="sm" variant="ghost" disabled={disabled} aria-label={`ensure group ${b.mesh}`}>建群</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Pending sender auth-codes → approve/revoke (dynamic-authz inbox; device-auth ⑤ overlap).
function PendingSendersCard({ state }: { state: ShellState }) {
  const disabled = state === "permission" || state === "offline";
  const busy = state === "busy";
  const pending = state === "empty" ? [] : state === "boundary" ? CH_PENDING_MANY : CH_PENDING;
  return (
    <div data-pending-senders className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-text-muted">待审批发送者 · authcode 入册 ({pending.length})</span>
        {/* enrollment overlaps device-auth — entry to the device/auth surface (#12). */}
        <LinkButton href="#" label="设备授权" dataKey="channel-enroll">设备授权 ↗</LinkButton>
      </div>
      {state === "error" ? <ErrorBanner title="Action failed" onRetry={() => {}}>approve/revoke 失败 — 重试。</ErrorBanner> : null}
      {pending.length === 0 ? <span className="text-xs text-text-muted">暂无待审批发送者。</span> : (
        <div className="flex flex-col gap-1.5">
          {pending.map((p) => (
            <div key={p.openId} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm">
              <StatusChip status="attention" variant="dot" />
              <code className="font-mono text-xs text-text-primary">{p.openId}</code>
              <span className="text-xs text-text-muted">authcode {p.authcode} · {p.when}</span>
              <span className="flex-1" aria-hidden="true" />
              {busy ? <Spinner size={12} label="resolving" /> : null}
              <Button size="sm" variant="primary" disabled={disabled} busy={busy} aria-label={`approve sender ${p.openId}`}>批准</Button>
              <Button size="sm" variant="ghost" disabled={disabled} aria-label={`revoke pending ${p.openId}`}>拒绝</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Authorized sender registry (allowSenders) → revoke.
function AuthorizedSendersCard({ state }: { state: ShellState }) {
  const disabled = state === "permission" || state === "offline";
  const senders = state === "boundary" ? CH_AUTHORIZED_MANY : CH_AUTHORIZED;
  return (
    <div data-authorized-senders className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">已授权发送者 · allowSenders ({senders.length})</span>
      <div className="flex flex-col gap-1.5">
        {senders.map((s) => (
          <div key={s.openId} className="flex flex-wrap items-center gap-2 text-sm">
            <StatusChip status="ready" variant="dot" />
            <code className="font-mono text-xs text-text-primary">{s.openId}</code>
            <span className="text-xs text-text-muted">{s.label}</span>
            <span className="flex-1" aria-hidden="true" />
            <Button size="sm" variant="ghost" disabled={disabled} aria-label={`revoke sender ${s.openId}`}>撤销</Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChannelsFrame({ state, device }: { state: ShellState; device: Device }) {
  const mobile = device === "mobile";
  const disabled = state === "permission" || state === "offline";
  return (
    <div data-mockup="frame" data-device={device} data-channels="panel"
      className={`flex ${mobile ? "h-[760px] w-[390px] rounded-[28px]" : "h-[700px] w-[1280px] rounded-xl"} max-w-full flex-col overflow-hidden border border-border bg-surface text-text-primary shadow-sm`}>
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        <Brand /><span className="text-text-muted">·</span>
        <span className="text-sm font-semibold">Channels</span>
        {mobile ? <StatusChip status="idle" variant="soft" label="只读" /> : null}
        <span className="flex-1" aria-hidden="true" />
        <Button size="sm" variant="ghost" disabled={disabled} aria-label="refresh channel status">refresh</Button>
      </header>
      {state === "permission" ? <div role="status" className="border-b border-border bg-danger-subtle px-4 py-1.5 text-xs text-danger">设备未授权 — 绑定 / 审批 / 撤销需已授权设备；状态只读。</div> : null}
      {state === "offline" ? <div role="status" className="flex items-center gap-2 border-b border-border bg-warning-subtle px-4 py-1.5 text-xs text-warning"><Spinner size={12} label="reconnecting" /> 连接已断开 — 正在重连…（显示最近已知，操作禁用）</div> : null}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className={`mx-auto flex flex-col gap-4 ${mobile ? "" : "max-w-[860px]"}`}>
          {state === "loading" ? (
            <div className="flex flex-col gap-3"><Skeleton variant="line" /><Skeleton variant="row" /><Skeleton variant="card" /></div>
          ) : (
            <>
              <ChannelStatusCard state={state} />
              {/* Mobile = read-only status + the actionable pending-sender inbox; binding/registry desktop-only (△). */}
              {!mobile ? <ChannelBindingsCard state={state} mobile={mobile} /> : null}
              <PendingSendersCard state={state} />
              {!mobile && state !== "empty" ? <AuthorizedSendersCard state={state} /> : null}
              {mobile ? <p className="text-xs text-text-muted">绑定 / 已授权注册表在桌面端管理（移动端聚焦待审批收件箱）。</p> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Doctor / system (08) — health checks + ps daemons + leak recovery ───────────────
// Mirrors src/diagnostics: DoctorReport (checks: id/severity/detail/fixHint + summary),
// PsDetail (running MeshProcDetail + leaks ProcLeak stale_record/orphan_socket). Recovery
// scope (user-approved WebUI): reap orphan + restart daemon. fetchDoctor is device-auth gated.
type Sev = "ok" | "info" | "warning" | "error";
const SEV_TONE: Record<Sev, Status> = { ok: "ready", info: "idle", warning: "attention", error: "blocked" };
const DOCTOR_VERSION = "agent-mesh v0.42.0 · build 2026-06-21";
interface DoctorCheckRow { id: string; severity: Sev; detail: string; fixHint?: string }
const DOCTOR_CHECKS: DoctorCheckRow[] = [
  { id: "host.key", severity: "ok", detail: "host key present (HKDF derive ok)" },
  { id: "port.10010", severity: "ok", detail: "control plane listening on 127.0.0.1:10010" },
  { id: "service.backend", severity: "ok", detail: "backend alive (pid 4821)" },
  { id: "config.meshes", severity: "warning", detail: "meshes/scratch.json references a missing project path", fixHint: "fix the project path or remove the mesh" },
  { id: "harness.codex", severity: "warning", detail: "codex-acp 1.2.3 outdated (latest 1.2.5)", fixHint: "update from the Harnesses panel" },
  { id: "harness.opencode", severity: "error", detail: "opencode not installed", fixHint: "self-install: npm i -g opencode, then reprobe" },
  { id: "auth.store", severity: "ok", detail: "auth-store sealed; 2 authorized devices" },
];
const DOCTOR_SUMMARY = { total: 7, ok: 4, warnings: 2, errors: 1, worst: "error" as Sev };
const DOCTOR_CHECKS_MANY: DoctorCheckRow[] = [
  ...DOCTOR_CHECKS,
  { id: "deps.bun", severity: "ok", detail: "bun 1.3.14" }, { id: "deps.git", severity: "ok", detail: "git 2.45" },
  { id: "port.15080", severity: "info", detail: "preview port 15080 in use by a demo" },
  { id: "harness.kimi", severity: "warning", detail: "kimi version unknown", fixHint: "reprobe" },
  { id: "orphan.scan", severity: "error", detail: "2 orphan processes detected", fixHint: "reap from the recovery panel below" },
  { id: "disk.run", severity: "ok", detail: "~/.agent-mesh/run writable" },
];
interface Daemon { name: string; pid: number; uptime: string; socket: string; agents: number }
const DAEMONS: Daemon[] = [
  { name: "dev-mesh", pid: 4830, uptime: "2h14m", socket: "~/.agent-mesh/run/dev-mesh.sock", agents: 4 },
  { name: "ops", pid: 4915, uptime: "38m", socket: "~/.agent-mesh/run/ops.sock", agents: 2 },
];
const DAEMONS_MANY: Daemon[] = [
  ...DAEMONS,
  { name: "infra", pid: 5001, uptime: "5h02m", socket: "~/.agent-mesh/run/infra.sock", agents: 3 },
  { name: "research", pid: 5044, uptime: "12m", socket: "~/.agent-mesh/run/research.sock", agents: 1 },
  { name: "security-audit", pid: 5120, uptime: "1h30m", socket: "~/.agent-mesh/run/security-audit.sock", agents: 2 },
];
interface Leak { name: string; kind: "stale_record" | "orphan_socket"; pid?: number; detail: string }
const LEAKS: Leak[] = [
  { name: "scratch", kind: "stale_record", pid: 3001, detail: "record points at dead pid 3001" },
  { name: "old-mesh", kind: "orphan_socket", detail: "orphan socket with no live owner" },
];
const LEAKS_MANY: Leak[] = [
  ...LEAKS,
  { name: "demo-1", kind: "stale_record", pid: 3102, detail: "record points at dead pid 3102" },
  { name: "demo-2", kind: "orphan_socket", detail: "orphan socket with no live owner" },
  { name: "demo-3", kind: "stale_record", pid: 3204, detail: "record points at dead pid 3204" },
];

function DoctorSummaryBar({ state, mobile }: { state: ShellState; mobile: boolean }) {
  const disabled = state === "offline";
  const s = state === "boundary" ? { total: 13, ok: 8, warnings: 3, errors: 2, worst: "error" as Sev } : DOCTOR_SUMMARY;
  return (
    <div data-doctor-summary className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-raised p-3">
      <StatusChip status={SEV_TONE[s.worst]} variant="soft" label={`worst: ${s.worst}`} />
      <span className="text-xs text-text-muted">{s.ok} ok · {s.warnings} warn · {s.errors} error · {s.total} 总计</span>
      <span className="text-xs text-text-muted">· {DOCTOR_VERSION}{state === "offline" ? "（cached）" : ""}</span>
      <span className="flex-1" aria-hidden="true" />
      <Button size="sm" variant="ghost" disabled={disabled} aria-label="copy diagnostics">copy 诊断</Button>
      {!mobile ? <Button size="sm" variant="secondary" disabled={disabled} busy={state === "busy"} aria-label="run doctor">{state === "busy" ? "running…" : "run doctor"}</Button> : null}
    </div>
  );
}

function DoctorFindings({ state }: { state: ShellState }) {
  const checks = state === "boundary" ? DOCTOR_CHECKS_MANY : DOCTOR_CHECKS;
  return (
    <div data-doctor-findings className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-raised p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">doctor findings ({checks.length})</span>
      {checks.map((c) => (
        <div key={c.id} className="flex flex-col gap-0.5 border-b border-border py-1.5 last:border-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={SEV_TONE[c.severity]} variant="dot" />
            <code className="font-mono text-xs text-text-secondary">{c.id}</code>
            <StatusChip status={SEV_TONE[c.severity]} variant="soft" label={c.severity} />
            <span className="min-w-0 flex-1 text-sm text-text-primary">{c.detail}</span>
          </div>
          {c.fixHint ? <span className="pl-6 text-xs text-text-muted">↳ {c.fixHint}</span> : null}
        </div>
      ))}
    </div>
  );
}

function DaemonTable({ state, mobile }: { state: ShellState; mobile: boolean }) {
  const none = state === "empty";
  const daemons = state === "boundary" ? DAEMONS_MANY : DAEMONS;
  const disabled = state === "permission" || state === "offline";
  return (
    <div data-daemons className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-raised p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">mesh-host daemons · ps ({none ? 0 : daemons.length})</span>
      {none ? <span className="text-xs text-text-muted">none running.</span> : daemons.map((d) => (
        <div key={d.name} className="flex flex-wrap items-center gap-2 border-b border-border py-1.5 text-sm last:border-0">
          <StatusChip status="working" variant="dot" />
          <span className="font-medium text-text-primary">{d.name}</span>
          <span className="font-mono text-xs text-text-muted">pid {d.pid} · up {d.uptime} · {d.agents} agents</span>
          {!mobile ? <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted">{d.socket}</span> : <span className="flex-1" aria-hidden="true" />}
          {/* Recovery: restart daemon (operator; desktop). */}
          {!mobile ? <Button size="sm" variant="ghost" disabled={disabled} aria-label={`restart daemon ${d.name}`}>restart</Button> : null}
        </div>
      ))}
    </div>
  );
}

// Recovery panel: reap orphan/stale leaks (user-approved WebUI scope) — operator/desktop.
function DoctorRecovery({ state }: { state: ShellState }) {
  const disabled = state === "permission" || state === "offline";
  const busy = state === "busy";
  const leaks = state === "boundary" ? LEAKS_MANY : LEAKS;
  return (
    <div data-recovery className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-text-muted">恢复 · 孤儿/僵尸进程 ({leaks.length})</span>
        <Button size="sm" variant="secondary" disabled={disabled} busy={busy} aria-label="reap all orphans">reap all</Button>
      </div>
      {state === "error" ? <ErrorBanner title="Reap failed" onRetry={() => {}}>清理失败 — 重试。</ErrorBanner> : null}
      <div className="flex flex-col gap-1.5">
        {leaks.map((l) => (
          <div key={l.name} data-leak className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm">
            <StatusChip status={l.kind === "orphan_socket" ? "attention" : "blocked"} variant="dot" />
            <span className="font-medium text-text-primary">{l.name}</span>
            <StatusChip status="idle" variant="soft" label={l.kind} />
            <span className="min-w-0 flex-1 text-xs text-text-muted">{l.detail}</span>
            {busy ? <Spinner size={12} label="reaping" /> : null}
            <Button size="sm" variant="ghost" disabled={disabled} aria-label={`reap ${l.name}`}>reap</Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function DoctorFrame({ state, device }: { state: ShellState; device: Device }) {
  const mobile = device === "mobile";
  const perm = state === "permission";
  const offline = state === "offline";
  const disabled = perm || offline;
  return (
    <div data-mockup="frame" data-device={device} data-doctor="panel"
      className={`flex ${mobile ? "h-[760px] w-[390px] rounded-[28px]" : "h-[700px] w-[1280px] rounded-xl"} max-w-full flex-col overflow-hidden border border-border bg-surface text-text-primary shadow-sm`}>
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        <Brand /><span className="text-text-muted">·</span>
        <span className="text-sm font-semibold">Doctor / 系统</span>
        {mobile ? <StatusChip status="idle" variant="soft" label="只读" /> : null}
        <span className="flex-1" aria-hidden="true" />
        <Button size="sm" variant="ghost" disabled={disabled} aria-label="refresh diagnostics">refresh</Button>
      </header>
      {perm ? <div role="status" className="border-b border-border bg-danger-subtle px-4 py-1.5 text-xs text-danger">设备未授权 — 系统诊断需已授权设备（服务端 device-auth 门禁）。</div> : null}
      {offline ? <div role="status" className="flex items-center gap-2 border-b border-border bg-danger-subtle px-4 py-1.5 text-xs text-danger"><Spinner size={12} label="reconnecting" /> 服务不可达 — backend down；显示最近已知诊断，恢复操作禁用。</div> : null}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className={`mx-auto flex flex-col gap-4 ${mobile ? "" : "max-w-[900px]"}`}>
          {state === "loading" ? (
            <div className="flex flex-col gap-3"><Skeleton variant="line" /><Skeleton variant="row" /><Skeleton variant="card" /></div>
          ) : perm ? (
            <EmptyState icon={<span className="text-2xl">🔒</span>} title="诊断已锁定" description="批准本设备后即可查看 doctor 检查、daemon 列表与恢复操作。" action={<Button variant="primary">去设置批准设备</Button>} />
          ) : (
            <>
              <DoctorSummaryBar state={state} mobile={mobile} />
              {state === "error" ? <ErrorBanner title="Doctor probe failed" onRetry={() => {}}>诊断请求失败 — backend 仍在线则可重试。</ErrorBanner> : null}
              <DoctorFindings state={state} />
              <DaemonTable state={state} mobile={mobile} />
              {/* Recovery actions deferred to desktop on mobile (matrix △). */}
              {!mobile && state !== "empty" ? <DoctorRecovery state={state} /> : null}
              {mobile ? <p className="text-xs text-text-muted">恢复操作（reap / restart daemon）在桌面端或 CLI 执行。</p> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Settings (09) — appearance(mode×accent + palette) / language / prefs / devices ──
// Mirrors themes.ts (MODES×ACCENTS compose + custom palette), i18n.ts (Lang en/zh), and
// device-auth (DeviceAuthPhase pending/approved/revoked; submitBootstrap; host-CLI
// authoritative approve, WebUI review/revoke). default-view/default-device are [N] prefs.
const PALETTE_TOKENS: { key: string; hex: string }[] = [
  { key: "bg", hex: "#0f172a" }, { key: "fg", hex: "#e2e8f0" }, { key: "accent", hex: "#2dd4bf" },
  { key: "ok", hex: "#4ec97a" }, { key: "warn", hex: "#e2b341" }, { key: "bad", hex: "#f0584b" },
];
type DevPhase = "this" | "approved" | "pending" | "revoked";
const DEV_TONE: Record<DevPhase, Status> = { this: "ready", approved: "ready", pending: "attention", revoked: "blocked" };
interface DeviceRow { id: string; label: string; phase: DevPhase; lastSeen: string }
const DEVICES: DeviceRow[] = [
  { id: "dev-this", label: "this device · Chrome / WSL", phase: "this", lastSeen: "now" },
  { id: "dev-2", label: "MacBook · Safari", phase: "approved", lastSeen: "2h" },
  { id: "dev-3", label: "iPhone · Feishu webview", phase: "pending", lastSeen: "3m" },
  { id: "dev-4", label: "old laptop", phase: "revoked", lastSeen: "5d" },
];
const DEVICES_MANY: DeviceRow[] = [
  ...DEVICES,
  { id: "dev-5", label: "iPad · Safari", phase: "approved", lastSeen: "1d" },
  { id: "dev-6", label: "work desktop", phase: "approved", lastSeen: "4h" },
  { id: "dev-7", label: "android · Feishu", phase: "pending", lastSeen: "9m" },
  { id: "dev-8", label: "kiosk", phase: "revoked", lastSeen: "12d" },
];

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">{title}</span>
      {children}
    </section>
  );
}

function AppearanceGroup({ state, mode, accent, onMode, onAccent }: { state: ShellState; mode: Mode; accent: Accent; onMode: (m: Mode) => void; onAccent: (a: Accent) => void }) {
  const errHex = state === "error"; // invalid-hex tolerated (no throw)
  return (
    <SettingsGroup title="外观 · 主题">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">背景模式</span>
        <SegmentedControl ariaLabel="theme mode" value={mode} onChange={(m) => onMode(m as Mode)} options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))} size="sm" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">强调色 Accent</span>
        <SegmentedControl ariaLabel="accent" value={accent} onChange={(a) => onAccent(a as Accent)} options={ACCENTS.map((a) => ({ value: a, label: ACCENT_LABEL[a] }))} size="sm" />
      </div>
      {state === "boundary" ? (
        <div data-theme-matrix className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">9 组 mode × accent 预览</span>
          <div className="grid grid-cols-3 gap-1">
            {MODES.flatMap((m) => ACCENTS.map((a) => {
              const c = compose(m, a);
              return <div key={`${m}-${a}`} className="flex items-center gap-1 rounded border border-border px-1.5 py-1 text-[10px] text-text-muted" style={{ background: c.surface }}><span className="h-3 w-3 rounded-full" style={{ background: c.accent }} /> {m.slice(0, 4)}·{a.slice(0, 4)}</div>;
            }))}
          </div>
        </div>
      ) : null}
      {/* Custom palette editor (advanced) — tolerant of transient invalid hex (no throw). */}
      <details data-custom-palette className="rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5">
        <summary className="cursor-pointer text-xs text-text-muted">自定义调色板（高级）</summary>
        <div className="mt-2 flex flex-col gap-1.5">
          {PALETTE_TOKENS.map((t, i) => {
            const invalid = errHex && i === 0;
            return (
              <div key={t.key} className="flex items-center gap-2">
                <span className="w-16 font-mono text-xs text-text-secondary">{t.key}</span>
                <span className="h-5 w-5 rounded border border-border-strong" style={{ background: invalid ? "transparent" : t.hex }} aria-hidden="true" />
                <Input defaultValue={invalid ? "#zz" : t.hex} error={invalid} aria-label={`palette ${t.key}`} className="w-28 font-mono" />
                {invalid ? <span className="text-xs text-text-muted">无效 hex — 已忽略（不抛错）</span> : null}
              </div>
            );
          })}
        </div>
      </details>
    </SettingsGroup>
  );
}

function DeviceGroup({ state }: { state: ShellState }) {
  const disabled = state === "offline"; // offline disables device mutations
  const perm = state === "permission"; // approve is host-CLI authoritative
  const busy = state === "busy";
  const devices = state === "boundary" ? DEVICES_MANY : state === "empty" ? [DEVICES[0]] : DEVICES;
  return (
    <SettingsGroup title="设备授权 · device management">
      {perm ? <p className="text-xs text-text-muted">approve 由宿主 CLI 授权（authoritative）；WebUI 可复核待批与撤销。</p> : null}
      {state === "error" ? <ErrorBanner title="Action failed" onRetry={() => {}}>approve/revoke 失败 — 重试。</ErrorBanner> : null}
      <div className="flex flex-col gap-1.5">
        {devices.map((d) => (
          <div key={d.id} data-device-row className="flex flex-wrap items-center gap-2 text-sm">
            <StatusChip status={DEV_TONE[d.phase]} variant="dot" />
            <span className="font-medium text-text-primary">{d.label}</span>
            <StatusChip status={DEV_TONE[d.phase]} variant="soft" label={d.phase === "this" ? "this device" : d.phase} />
            <span className="text-xs text-text-muted">seen {d.lastSeen}</span>
            <span className="flex-1" aria-hidden="true" />
            {busy ? <Spinner size={12} label="resolving" /> : null}
            {d.phase === "pending" ? <Button size="sm" variant="primary" disabled={disabled || perm} busy={busy} aria-label={`approve device ${d.id}`}>批准</Button> : null}
            {d.phase !== "this" && d.phase !== "revoked" ? <Button size="sm" variant="ghost" disabled={disabled} aria-label={`revoke device ${d.id}`}>撤销</Button> : null}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" disabled={disabled || perm} aria-label="mint bootstrap token">铸造 bootstrap token</Button>
        <span className="text-xs text-text-muted">首台设备引导（host-side echo）。</span>
      </div>
    </SettingsGroup>
  );
}

function SettingsFrame({ state, device, mode, accent, onMode, onAccent }: { state: ShellState; device: Device; mode: Mode; accent: Accent; onMode: (m: Mode) => void; onAccent: (a: Accent) => void }) {
  const mobile = device === "mobile";
  const offline = state === "offline";
  return (
    <div data-mockup="frame" data-device={device} data-settings="panel"
      className={`flex ${mobile ? "h-[760px] w-[390px] rounded-[28px]" : "h-[720px] w-[1280px] rounded-xl"} max-w-full flex-col overflow-hidden border border-border bg-surface text-text-primary shadow-sm`}>
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        <Brand /><span className="text-text-muted">·</span>
        <span className="text-sm font-semibold">设置 Settings</span>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-xs text-text-muted">本地偏好即时生效</span>
      </header>
      {offline ? <div role="status" className="flex items-center gap-2 border-b border-border bg-warning-subtle px-4 py-1.5 text-xs text-warning"><Spinner size={12} label="reconnecting" /> 连接已断开 — 外观/语言仍可改（本地）；设备管理与默认偏好已禁用。</div> : null}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className={`mx-auto flex flex-col gap-4 ${mobile ? "" : "max-w-[860px]"}`}>
          {state === "loading" ? (
            <div className="flex flex-col gap-3"><Skeleton variant="line" /><Skeleton variant="row" /><Skeleton variant="card" /></div>
          ) : (
            <>
              <AppearanceGroup state={state} mode={mode} accent={accent} onMode={onMode} onAccent={onAccent} />
              <SettingsGroup title="语言 · language">
                <SegmentedControl ariaLabel="language" value="zh" onChange={() => {}} options={[{ value: "en", label: "English" }, { value: "zh", label: "中文" }]} size="sm" />
                <span className="text-xs text-text-muted">技术名词（mesh / router / agent / harness）两种语言均保留英文。</span>
              </SettingsGroup>
              <SettingsGroup title="偏好 · preferences">
                <div className="flex flex-wrap items-center gap-4">
                  {/* default prefs are server-persisted → disabled offline (matrix △). */}
                  <label className="flex flex-col gap-1 text-xs text-text-muted">默认落地视图
                    <SegmentedControl ariaLabel="default landing view" value="runtime" onChange={() => {}} options={[{ value: "runtime", label: "运行态", disabled: offline }, { value: "board", label: "看板", disabled: offline }]} size="sm" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-text-muted">默认设备布局
                    <SegmentedControl ariaLabel="default device" value="desktop" onChange={() => {}} options={[{ value: "desktop", label: "桌面", disabled: offline }, { value: "mobile", label: "移动", disabled: offline }]} size="sm" />
                  </label>
                  {offline ? <span className="text-xs text-text-muted">（离线时偏好保存已禁用）</span> : null}
                </div>
              </SettingsGroup>
              <DeviceGroup state={state} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Notifications center (10) — app-level cross-mesh notices ([N], fixture-only) ─────
// NOT transcript / not a mesh's local mail. Classes: harness upgrade, frontend self-update,
// connection/service status, system alert, device-auth; action targets point at the [E]
// surfaces (harnesses/doctor/settings). No backend — server persistence/unread = later phase.
type NotifClass = "harness" | "update" | "service" | "system" | "device";
const NOTIF_ICON: Record<NotifClass, string> = { harness: "⬆", update: "⟳", service: "🛰", system: "⚙", device: "🔑" };
const NOTIF_TONE: Record<NotifClass, Status> = { harness: "attention", update: "ready", service: "working", system: "idle", device: "attention" };
interface Notif { id: string; cls: NotifClass; title: string; detail: string; time: string; unread: boolean; actionLabel: string; actionSurface?: Surface }
const NOTIFS: Notif[] = [
  { id: "n1", cls: "harness", title: "codex-acp 有更新 v1.2.3 → v1.2.5", detail: "在 Harnesses 面板更新并重启旧版本 agent", time: "2m", unread: true, actionLabel: "打开 Harnesses", actionSurface: "harnesses" },
  { id: "n2", cls: "update", title: "控制台前端有新版本", detail: "刷新以加载最新 WebUI", time: "15m", unread: true, actionLabel: "刷新更新" },
  { id: "n3", cls: "service", title: "backend 短暂不可达后已恢复", detail: "诊断详情见 Doctor", time: "1h", unread: true, actionLabel: "打开 Doctor", actionSurface: "doctor" },
  { id: "n4", cls: "device", title: "有新设备申请授权", detail: "iPhone · Feishu webview 待批准", time: "3h", unread: false, actionLabel: "打开设置", actionSurface: "settings" },
  { id: "n5", cls: "system", title: "自动 compact 已触发（dev-mesh / codex-1）", detail: "上下文达 85% 阈值", time: "5h", unread: false, actionLabel: "查看" },
];
const NOTIFS_MANY: Notif[] = [
  { id: "b0", cls: "system", title: "一条很长的系统通知标题，用来检验在抽屉与移动端全屏列表里的截断与换行行为是否优雅而不破坏布局", time: "1m", detail: "long-title boundary", unread: true, actionLabel: "查看" },
  ...NOTIFS,
  { id: "n6", cls: "harness", title: "kimi 版本未知", detail: "reprobe 以检测", time: "6h", unread: false, actionLabel: "打开 Harnesses", actionSurface: "harnesses" },
  { id: "n7", cls: "service", title: "Feishu channel 已连接", detail: "ops@host 群已绑定", time: "8h", unread: false, actionLabel: "打开渠道", actionSurface: "channels" },
  { id: "n8", cls: "update", title: "依赖更新可用：bun 1.3.15", detail: "见 Doctor", time: "1d", unread: false, actionLabel: "打开 Doctor", actionSurface: "doctor" },
  { id: "n9", cls: "system", title: "孤儿进程已清理（2）", detail: "Doctor 恢复面板", time: "2d", unread: false, actionLabel: "查看" },
];

function NotifItem({ n, device, mode, accent, disabled, busy }: { n: Notif; device: Device; mode: Mode; accent: Accent; disabled: boolean; busy: boolean }) {
  const followHref = n.actionSurface
    ? `/__ui-mockup?surface=${n.actionSurface}&state=populated&device=${device}&mode=${mode}&accent=${accent}`
    : undefined;
  return (
    <div data-notif data-unread={n.unread ? "1" : undefined} className={`flex flex-col gap-1 rounded-lg border px-3 py-2 ${n.unread ? "border-border-strong bg-surface-raised" : "border-border bg-surface-sunken"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {n.unread ? <span data-unread-dot aria-label="unread" className="h-2 w-2 rounded-full bg-accent" /> : <span className="h-2 w-2" aria-hidden="true" />}
        <StatusChip status={NOTIF_TONE[n.cls]} variant="soft" label={`${NOTIF_ICON[n.cls]} ${n.cls}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{n.title}</span>
        <span className="shrink-0 text-xs text-text-muted">{n.time}</span>
      </div>
      <div className="pl-4 text-xs text-text-muted">{n.detail}</div>
      <div className="flex items-center gap-2 pl-4">
        {followHref
          ? <LinkButton href={followHref} label={n.actionLabel}>{n.actionLabel} →</LinkButton>
          : <Button size="sm" variant="ghost" disabled={n.actionLabel === "刷新更新" ? false : disabled} aria-label={n.actionLabel}>{n.actionLabel}</Button>}
        {n.unread ? <Button size="sm" variant="ghost" disabled={disabled} busy={busy} aria-label={`mark read ${n.id}`}>标记已读</Button> : null}
      </div>
    </div>
  );
}

function NotificationsFrame({ state, device, mode, accent }: { state: ShellState; device: Device; mode: Mode; accent: Accent }) {
  const mobile = device === "mobile";
  const offline = state === "offline";
  const perm = state === "permission";
  const busy = state === "busy";
  const disabled = offline; // mark-read / net-needing actions disabled offline
  const baseList = state === "boundary" ? NOTIFS_MANY : NOTIFS;
  // In permission state, surface an unread device-auth notice so the gated (disabled)
  // device-class mark-read is actually visible/testable (matrix: action may be gated).
  const list = perm ? baseList.map((n) => (n.cls === "device" ? { ...n, unread: true } : n)) : baseList;
  const unread = list.filter((n) => n.unread);
  const read = list.filter((n) => !n.unread);
  const unreadCount = state === "boundary" ? 250 : unread.length;
  return (
    <div data-mockup="frame" data-device={device} data-notifications="center"
      className={`flex ${mobile ? "h-[760px] w-[390px] rounded-[28px]" : "h-[700px] w-[1280px] rounded-xl"} max-w-full flex-col overflow-hidden border border-border bg-surface text-text-primary shadow-sm`}>
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        <Brand /><span className="text-text-muted">·</span>
        <span className="text-sm font-semibold">通知 Notifications</span>
        <span className="text-xs text-text-muted">{mobile ? "全屏列表" : "抽屉"}</span>
        {unreadCount > 0 && state !== "empty" ? <Badge count={unreadCount} max={99} tone="urgent" /> : null}
        <span className="flex-1" aria-hidden="true" />
        <Button size="sm" variant="ghost" disabled={disabled || state === "empty"} busy={busy} aria-label="mark all read">全部已读</Button>
      </header>
      {offline ? <div role="status" className="flex items-center gap-2 border-b border-border bg-warning-subtle px-4 py-1.5 text-xs text-warning"><Spinner size={12} label="reconnecting" /> 连接已断开 — 显示最近已知通知；标记已读已禁用。</div> : null}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className={`mx-auto flex flex-col gap-2 ${mobile ? "" : "max-w-[680px]"}`}>
          {state === "loading" ? (
            <div className="flex flex-col gap-2"><Skeleton variant="row" /><Skeleton variant="row" /><Skeleton variant="card" /></div>
          ) : state === "empty" ? (
            <EmptyState icon={<span className="text-2xl">🎉</span>} title="全部已读" description="没有新的系统通知。harness 升级、前端更新、服务状态等会出现在这里。" />
          ) : (
            <>
              {state === "error" ? <ErrorBanner title="加载通知失败" onRetry={() => {}}>历史拉取失败 — 重试；动作目标失败会就地提示。</ErrorBanner> : null}
              {offline ? <div data-notif data-conn-lost className="flex items-center gap-2 rounded-lg border border-border-strong bg-warning-subtle px-3 py-2 text-sm text-warning"><span aria-hidden="true">🛰</span> 连接丢失 — 实时通知暂停</div> : null}
              {perm ? <p className="text-xs text-text-muted">只读浏览；需授权的动作（如批准设备）在未授权设备上禁用。</p> : null}
              {unread.map((n) => <NotifItem key={n.id} n={n} device={device} mode={mode} accent={accent} disabled={disabled || (perm && n.cls === "device")} busy={busy} />)}
              {read.length ? (
                <>
                  <div className="mt-2 flex items-center gap-2 text-xs uppercase tracking-wider text-text-muted"><span>历史 / 已读</span><span className="h-px flex-1 bg-border" aria-hidden="true" /></div>
                  {read.map((n) => <NotifItem key={n.id} n={n} device={device} mode={mode} accent={accent} disabled={disabled || (perm && n.cls === "device")} busy={busy} />)}
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── File / artifact viewer (11) — rendered md/code/image + lightbox + pending tray ──────
// Mirrors FileViewer.tsx LoadState (loading/error[status]/markdown/image/text[code]) at route
// /mesh/<m>/agent/<a>/artifact/<file>, AuthedImage (bearer fetch → object URL, alt on fail),
// the image lightbox, and the composer pending-image tray. Empty N/A (route targets a file);
// permission (401) folds into the error treatment.
const ARTIFACT_PATH = "mesh/dev-mesh/agent/codex-1/artifact/reports/gate-summary.md";
const ARTIFACT_MD = "# Gate summary\n\nAll gates green for the device-auth page. See the run log below.";
const ARTIFACT_CODE = "$ bun test\n  1647 pass / 0 fail\n$ bun run a11y\n  19 passed, 0 failed";
const ARTIFACT_CODE_LONG = ARTIFACT_CODE + "\n" + "// a very long line that should scroll horizontally without breaking the reader layout on desktop or the narrow mobile frame, exercising overflow-x in the code block".repeat(1);
const TRAY_IMAGES = ["shot-board.png", "topology.png"];
const TRAY_MANY = [...TRAY_IMAGES, "diagram-flow.png", "before.png", "after.png", "perf-trace.png", "huge-render-4k.png (8.2 MB)"];

// Inline image stand-in (AuthedImage) → opens the lightbox. `broken` shows the alt fallback.
function ArtifactImage({ lbHref, broken = false, label = "topology.png" }: { lbHref: string; broken?: boolean; label?: string }) {
  if (broken) {
    return <div data-artifact-image="alt" className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface-sunken text-xs text-text-muted">⊘ {label}（图片不可用，显示 alt）</div>;
  }
  return (
    <a href={lbHref} data-artifact-image aria-label={`zoom ${label}`} className="block overflow-hidden rounded-lg border border-border no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring">
      <div className="flex h-40 items-center justify-center bg-surface-sunken text-3xl text-text-muted">🖼 <span className="ml-2 text-xs">{label} · 点击放大</span></div>
    </a>
  );
}

// Composer pending-image tray — attach / preview / remove before send (covers all 8 states).
function PendingImageTray({ state }: { state: ShellState }) {
  const offline = state === "offline";
  const perm = state === "permission";
  const busy = state === "busy";
  const disabled = offline || perm; // capability-gated (perm) / disabled offline
  const imgs = state === "empty" ? [] : state === "boundary" ? TRAY_MANY : TRAY_IMAGES;
  const uploading = state === "loading";
  return (
    <div data-pending-tray className="flex flex-col gap-1.5 border-t border-border bg-surface-raised p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-text-muted">待发送图片 ({imgs.length})</span>
        {busy ? <span className="inline-flex items-center gap-1 text-xs text-text-secondary"><Spinner size={12} label="sending" /> 发送中…</span> : null}
        <span className="flex-1" aria-hidden="true" />
        <Button size="sm" variant="ghost" disabled={disabled || busy} aria-label="attach image" title={perm ? "harness 未声明图片输入" : "attach"}>📎 添加</Button>
      </div>
      {perm ? <span className="text-xs text-text-muted">该 harness 未声明图片输入 — 附件已禁用。</span> : null}
      {offline ? <span className="text-xs text-text-muted">离线 — 附件已禁用。</span> : null}
      {imgs.length === 0 && !uploading ? <span className="text-xs text-text-muted">无待发送图片。</span> : (
        <div className="flex flex-wrap gap-2">
          {uploading ? <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-border bg-surface-sunken"><Spinner size={14} label="uploading" /></div> : null}
          {imgs.map((img, i) => {
            const failed = state === "error" && i === 0;
            return (
              <div key={i} data-tray-thumb className="relative flex h-16 w-16 flex-col items-center justify-center rounded-lg border border-border bg-surface-sunken px-1 text-center">
                <span className="text-lg text-text-muted" aria-hidden="true">{failed ? "⚠" : "🖼"}</span>
                <span className="w-full truncate text-[9px] text-text-muted">{img}</span>
                {failed ? <span className="text-[9px] text-danger">上传失败</span> : null}
                <button type="button" disabled={disabled || busy} aria-label={`remove image ${i + 1}`} className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-border-strong bg-surface text-[10px] text-text-secondary disabled:cursor-not-allowed disabled:text-text-disabled">×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FileViewerFrame({ state, device, lb, lbHref, exitLbHref, backHref }: { state: ShellState; device: Device; lb: boolean; lbHref: string; exitLbHref: string; backHref: string }) {
  const mobile = device === "mobile";
  const boundary = state === "boundary";
  const offline = state === "offline";
  const err = state === "error";
  const perm = state === "permission"; // 401 → folds into error
  return (
    <div data-mockup="frame" data-device={device} data-artifact="viewer"
      className={`relative flex ${mobile ? "h-[760px] w-[390px] rounded-[28px]" : "h-[700px] w-[1280px] rounded-xl"} max-w-full flex-col overflow-hidden border border-border bg-surface text-text-primary shadow-sm`}>
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        {/* Back to conversation — a real link (URL-addressable, new-tab friendly). */}
        <a href={backHref} data-artifact-back aria-label="back to conversation" className="inline-flex items-center gap-1 rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-xs text-text-primary no-underline hover:bg-hover">← 返回对话</a>
        <span className="text-text-muted">·</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted" data-artifact-path>{ARTIFACT_PATH}</span>
        <StatusChip status="idle" variant="soft" label="artifact" />
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className={`mx-auto flex flex-col gap-3 ${mobile ? "" : "max-w-[820px]"}`}>
          {state === "empty" ? (
            <p className="text-sm text-text-muted">file-viewer 路由总是指向具体文件 — 无空态（N/A）。下方为 pending 图片托盘的空态。</p>
          ) : state === "loading" ? (
            <div className="flex items-center gap-2 text-sm text-text-secondary"><Spinner size={14} label="loading" /> Bearer 拉取中…</div>
          ) : err || perm ? (
            <ErrorBanner title={perm ? "Not permitted" : "File not found"} onRetry={perm ? undefined : () => {}}>
              {perm ? "401 — 该 artifact 不允许本设备访问（权限不足折叠为错误态）。" : "404 — 未找到该 artifact；坏 ref 会降级为纯文本。"} 用上方「返回对话」回到会话。
            </ErrorBanner>
          ) : (
            <>
              {offline ? <p className="text-xs text-text-muted">显示最近已知内容；图片显示 alt / 缓存。</p> : null}
              {/* markdown */}
              <div data-artifact-kind="markdown" className="flex flex-col gap-1">
                <h1 className="text-lg font-semibold text-text-primary">Gate summary</h1>
                <p className="text-sm text-text-primary">{ARTIFACT_MD.split("\n\n")[1]}</p>
              </div>
              {/* highlighted code */}
              <pre data-artifact-kind="code" className="overflow-x-auto rounded-lg bg-surface-sunken px-3 py-2 text-xs font-mono text-text-secondary">{boundary ? ARTIFACT_CODE_LONG : ARTIFACT_CODE}</pre>
              {/* inline image(s) → lightbox; offline shows alt */}
              <ArtifactImage lbHref={lbHref} broken={offline} label="topology.png" />
              {boundary ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{TRAY_MANY.slice(0, 6).map((n, i) => <ArtifactImage key={i} lbHref={lbHref} label={n} />)}</div> : null}
            </>
          )}
        </div>
      </div>
      <PendingImageTray state={state} />
      {/* Image lightbox overlay (zoom; mobile = pinch-zoom presentation). */}
      {lb ? (
        <div data-artifact-lightbox role="dialog" aria-modal="true" aria-label="image lightbox" className="absolute inset-0 z-20 flex flex-col" style={{ background: "rgba(0,0,0,0.85)" }}>
          <div className="flex items-center gap-2 px-4 py-2.5 text-xs text-text-on-selected">
            <span className="flex-1 truncate font-mono text-text-on-selected">topology.png</span>
            {!mobile ? <><Button size="sm" variant="ghost" aria-label="zoom out">－</Button><span className="tabular-nums text-text-on-selected">100%</span><Button size="sm" variant="ghost" aria-label="zoom in">＋</Button></> : <span className="text-text-on-selected">双指缩放</span>}
            <a href={exitLbHref} aria-label="close lightbox" className="rounded-lg border border-border-strong bg-surface px-2 py-1 text-text-primary no-underline">✕ Esc</a>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center text-6xl text-text-on-selected">🖼</div>
        </div>
      ) : null}
    </div>
  );
}

// ── Device-auth (12) — pre-auth unauthorized gate (single full-screen card) ─────────
// Mirrors device-auth.ts: device-code request + poll loop, phases pending/approved/revoked/
// unknown, submitBootstrap (body-only, never URL/persisted). Only allow path = an approved
// device token; loopback not trusted; host-CLI approve is authoritative; revoked/unknown/
// expired messages stay generic + non-leaky. Replaces the whole app while unauthorized.
const DEVICE_CODE = "WXYZ-1234";
const DEVICE_CODE_LONG = "WXYZ-1234-ABCD-5678-EFGH-9012";
const REMEMBERED_ROUTE = "/mesh/dev-mesh/agent/codex-1";
const REMEMBERED_ROUTE_LONG = "/mesh/release-candidate-2026-q3/agent/a-very-long-agent-id/artifact/reports/deep/nested/gate-summary.md";

function DeviceAuthFrame({ state, device }: { state: ShellState; device: Device }) {
  const mobile = device === "mobile";
  const na = state === "empty" || state === "populated"; // gate has no empty/populated
  const requesting = state === "loading";
  const expired = state === "error";
  const submitting = state === "busy";
  const offline = state === "offline";
  const boundary = state === "boundary";
  const code = boundary ? DEVICE_CODE_LONG : DEVICE_CODE;
  const route = boundary ? REMEMBERED_ROUTE_LONG : REMEMBERED_ROUTE;
  const bootstrapDisabled = offline || requesting;
  return (
    <div data-mockup="frame" data-device={device} data-device-auth="gate"
      className={`flex ${mobile ? "h-[760px] w-[390px] rounded-[28px]" : "h-[700px] w-[1280px] rounded-xl"} max-w-full flex-col items-center justify-center overflow-auto border border-border bg-surface p-6 text-text-primary shadow-sm`}>
      <div className={`flex w-full flex-col gap-4 rounded-2xl border border-border bg-surface-raised p-6 ${mobile ? "" : "max-w-[460px]"}`}>
        <div className="flex flex-col items-center gap-1 text-center">
          <Brand />
          <h1 className="text-lg font-semibold">设备授权</h1>
          <p className="text-xs text-text-muted">此设备尚未授权 — 授权后才能访问控制台。</p>
        </div>

        {na ? (
          <p data-device-auth-na className="text-sm text-text-muted">此页是未授权门禁，无 empty / populated 态（N/A）。授权成功即跳转到记住的深链。</p>
        ) : requesting ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-text-secondary"><Spinner size={16} label="requesting code" /> 正在请求设备码…</div>
        ) : (
          <>
            {offline ? <div role="status" className="flex items-center gap-2 rounded-lg bg-warning-subtle px-3 py-2 text-xs text-warning"><Spinner size={12} label="reconnecting" /> 服务不可用 — 与"未批准"不同；连接恢复后重试。</div> : null}
            {expired ? <div role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-xs text-danger">设备码 / 令牌无效或已过期。请刷新获取新码。</div> : null}

            {/* device code — operator approves via host CLI (authoritative) */}
            <div className="flex flex-col items-center gap-1">
              <span className="text-xs uppercase tracking-wider text-text-muted">设备码</span>
              <code data-device-code className={`rounded-lg border border-border-strong bg-surface-sunken px-4 py-2 font-mono font-semibold tracking-widest text-text-primary ${boundary ? "text-base break-all" : "text-2xl"} ${offline ? "opacity-50" : ""}`}>{code}</code>
              <span className="text-center text-xs text-text-muted">在宿主终端运行 <code className="font-mono text-text-secondary">mesh approve {code}</code> 批准本设备。</span>
            </div>

            {/* poll status */}
            <div className="flex items-center justify-center gap-2 text-xs text-text-secondary">
              {submitting ? <><Spinner size={12} label="resolving" /> 正在解析目标…</>
                : offline ? <span className="text-text-muted">轮询暂停（离线）。</span>
                : expired ? <Button size="sm" variant="primary" aria-label="refresh device code">刷新获取新码</Button>
                : <><Spinner size={12} label="polling" /> 等待宿主批准…（每 3s 轮询）</>}
            </div>

            <div className="flex items-center gap-2 text-xs text-text-muted"><span className="h-px flex-1 bg-border" aria-hidden="true" />或<span className="h-px flex-1 bg-border" aria-hidden="true" /></div>

            {/* bootstrap token — body-only, never URL/persisted */}
            <div data-bootstrap className="flex flex-col gap-1.5">
              <label className="text-xs uppercase tracking-wider text-text-muted">一次性 bootstrap 令牌（自助批准）</label>
              <Input aria-label="bootstrap token" placeholder="粘贴宿主日志里的一次性令牌…" disabled={bootstrapDisabled} className={`w-full font-mono ${boundary ? "" : ""}`} defaultValue={boundary ? "bootstrap_3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f" : ""} />
              <span className="text-xs text-text-muted">令牌仅随本次请求提交 — 不写入 URL、不持久化。</span>
              <Button variant="primary" disabled={bootstrapDisabled} busy={submitting} aria-label="submit bootstrap token" className="w-full">{submitting ? "提交中…" : "自助批准本设备"}</Button>
            </div>

            {/* remembered deep link + security footer */}
            <div data-remembered className="rounded-lg border border-border bg-surface-sunken px-3 py-2 text-xs text-text-muted">
              批准后将返回：<code className="break-all font-mono text-text-secondary">{route}</code>
            </div>
            <p className="text-center text-[11px] text-text-muted">唯一放行路径 = 已批准的设备令牌；loopback 不受信，<code className="font-mono">/api/*</code> 始终门禁。</p>
          </>
        )}
      </div>
    </div>
  );
}

// ── new-mesh builder (04) fixtures + frame ───────────────────────────────────────
interface AgentRow { id: string; harness: string; project: string; role: "router" | "member"; model?: string; effort?: string; lazy?: boolean; opencodePermission?: "ask" | "allow"; instructions?: string }
const HARNESSES = ["claude", "codex", "opencode", "kimi"];
const NM_MODELS = ["(default)", "opus-4.8", "sonnet-4.6", "gpt-5", "kimi-k2"];
const NM_EFFORTS = ["low", "medium", "high", "max"];
const NM_AGENTS: AgentRow[] = [
  { id: "router", harness: "claude", project: "~/projects/mesh", role: "router", model: "opus-4.8", effort: "high", instructions: "Route work to members; keep the board updated." },
  { id: "codex-1", harness: "codex", project: "~/projects/app", role: "member", model: "(default)", effort: "medium", lazy: false, instructions: "Implement + test; stop with [REQ] per commit." },
  { id: "reviewer", harness: "opencode", project: "~/projects/app", role: "member", model: "(default)", lazy: true, opencodePermission: "ask" },
];
const NM_EDGES = [{ from: "router", to: "codex-1" }, { from: "router", to: "reviewer" }, { from: "codex-1", to: "reviewer" }];
const NM_MANY_AGENTS: AgentRow[] = [
  ...NM_AGENTS,
  { id: "codex-2", harness: "codex", project: "~/projects/app", role: "member" },
  { id: "claude-2", harness: "claude", project: "~/projects/docs", role: "member" },
  { id: "opencode-1", harness: "opencode", project: "~/projects/infra", role: "member" },
  { id: "kimi-1", harness: "kimi", project: "~/projects/research", role: "member" },
  { id: "a-very-long-agent-identifier-for-truncation", harness: "claude", project: "~/projects/a/very/long/nested/project/path/that/wraps", role: "member" },
  { id: "reviewer-2", harness: "claude", project: "~/projects/app", role: "member" },
  { id: "security-1", harness: "codex", project: "~/projects/security", role: "member" },
];
const NM_MANY_EDGES = [
  ...NM_EDGES, { from: "router", to: "codex-2" }, { from: "router", to: "claude-2" }, { from: "router", to: "opencode-1" },
  { from: "router", to: "kimi-1" }, { from: "codex-1", to: "reviewer-2" }, { from: "codex-2", to: "reviewer-2" },
  { from: "claude-2", to: "security-1" }, { from: "security-1", to: "reviewer" },
];

// Per-state form shape (loading is N/A for a local create form; offline locks the
// retained draft — disables mutating fields/actions/Save, keeps Cancel — see 04 coverage).
function nmForm(state: ShellState) {
  const boundary = state === "boundary";
  const agents = state === "empty" ? [NM_AGENTS[0]] : boundary ? NM_MANY_AGENTS : NM_AGENTS;
  const edges = state === "empty" ? [] : boundary ? NM_MANY_EDGES : NM_EDGES;
  const name = state === "empty" ? "" : boundary ? "release-candidate-2026-q3-extended-pipeline" : "dev-mesh";
  const nameError = state === "error" ? "a mesh named “dev-mesh” already exists" : undefined;
  const disabled = state === "permission" || state === "offline"; // unauthorized can't create; offline locks edits
  const busy = state === "busy";
  const valid = state === "populated" || state === "boundary"; // save enabled only when valid
  return { agents, edges, name, nameError, disabled, busy, valid, boundary };
}

// Expanded text editor — desktop centered modal / mobile full-screen sheet (mirrors
// MeshBuilder.tsx TextEditorDialog: role=dialog, aria-modal, char-count, Cancel/Apply).
function NmTextEditor({ kind, mobile }: { kind: "charter" | "instructions"; mobile: boolean }) {
  const title = kind === "charter" ? "Charter" : "codex-1 · instructions";
  const value = kind === "charter"
    ? "Ship the device-auth page and keep the gate fail-closed."
    : "Implement + test; stop with [REQ] per commit. Keep the worktree clean and never push without approval.";
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface-overlay/0" style={{ background: "rgba(0,0,0,0.45)" }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${title} editor`}
        data-newmesh-editor={kind}
        className={`flex flex-col gap-3 border border-border-strong bg-surface-raised text-text-primary shadow-sm ${mobile ? "absolute inset-0 rounded-none p-4" : "w-[640px] max-w-[92%] rounded-xl p-4"}`}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" iconOnly aria-label="close editor">✕</Button>
        </div>
        <Textarea defaultValue={value} aria-label={`${title} full editor`} rows={mobile ? 16 : 10} className="flex-1" />
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-muted tabular-nums">{value.length} / 4000</span>
          <Cluster><Button variant="ghost" size="sm">Cancel</Button><Button variant="primary" size="sm">Apply</Button></Cluster>
        </div>
      </div>
    </div>
  );
}

function NewMeshFrame({ state, device, nmEditor = "off" }: { state: ShellState; device: Device; nmEditor?: NmEditor }) {
  const f = nmForm(state);
  const mobile = device === "mobile";
  const ctrlDisabled = f.disabled || f.busy;
  return (
    <div data-mockup="frame" data-device={device} data-newmesh="builder" className={`relative ${mobile ? "flex h-[760px] w-[390px] flex-col rounded-[28px]" : "w-[1280px] rounded-xl"} max-w-full overflow-hidden border border-border bg-surface text-text-primary shadow-sm`}>
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        <Brand />
        <span className="text-text-muted">·</span>
        <span className="text-sm font-semibold">New mesh</span>
        <span className="flex-1" aria-hidden="true" />
        {/* Cancel stays enabled even offline — it is purely local navigation (no mutation). */}
        <Button variant="ghost" size="sm">Cancel</Button>
        <Button variant="primary" size="sm" disabled={!f.valid || f.disabled} busy={f.busy}>Save</Button>
      </header>
      {state === "permission" ? <div role="status" className="border-b border-border bg-danger-subtle px-4 py-1.5 text-xs text-danger">设备未授权 — 无法创建 mesh；请在「设置」批准本设备。</div> : null}
      {state === "offline" ? <div role="status" className="flex items-center gap-2 border-b border-border bg-warning-subtle px-4 py-1.5 text-xs text-warning"><Spinner size={12} label="reconnecting" /> 连接已断开 — 正在重连…（草稿保留，编辑与保存已禁用）</div> : null}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className={`mx-auto flex flex-col gap-5 ${mobile ? "" : "max-w-[820px]"}`}>
          {state === "error" ? <ErrorBanner title="Fix 2 errors to save">Duplicate mesh name and one agent is missing an id.</ErrorBanner> : null}

          <section className="flex flex-col gap-1.5">
            <label className="text-xs uppercase tracking-wider text-text-muted">mesh name</label>
            <Input defaultValue={f.name} placeholder="my-mesh" error={!!f.nameError} disabled={ctrlDisabled} aria-label="mesh name" className={mobile ? "w-full" : "max-w-sm"} />
            {f.nameError ? <span className="text-xs text-danger">{f.nameError}</span> : <span className="text-xs text-text-muted">unique; lowercase recommended</span>}
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-text-muted">agents · {f.agents.length}</span>
              <Button variant="secondary" size="sm" disabled={ctrlDisabled}>+ Add agent</Button>
            </div>
            <div className="flex flex-col gap-2">
              {f.agents.map((a, i) => {
                const missingId = state === "error" && i === f.agents.length - 1; // last row missing id in error state
                return (
                  <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-raised p-2.5">
                    {/* line 1: id · harness · role · delete */}
                    <div className={`flex gap-1.5 ${mobile ? "flex-wrap" : "items-center"}`}>
                      <Input defaultValue={missingId ? "" : a.id} error={missingId} disabled={ctrlDisabled} aria-label={`agent ${i + 1} id`} placeholder="agent id" className={mobile ? "w-full" : "w-40"} />
                      <Select defaultValue={a.harness} disabled={ctrlDisabled} aria-label={`agent ${i + 1} harness`} className={mobile ? "flex-1" : "w-32"}>{HARNESSES.map((h) => <option key={h}>{h}</option>)}</Select>
                      <Select defaultValue={a.role} disabled={ctrlDisabled} aria-label={`agent ${i + 1} role`} className={mobile ? "flex-1" : "w-28"}><option>router</option><option>member</option></Select>
                      {!mobile ? <span className="flex-1" aria-hidden="true" /> : null}
                      <Button variant="ghost" size="sm" iconOnly aria-label={`remove agent ${i + 1}`} disabled={ctrlDisabled || a.role === "router"}>×</Button>
                    </div>
                    {/* line 2: project */}
                    <Input defaultValue={a.project} disabled={ctrlDisabled} aria-label={`agent ${i + 1} project`} placeholder="project path" className="w-full" />
                    {/* line 3: model · effort · lazy · (opencode permission) */}
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex items-center gap-1 text-xs text-text-muted">model
                        <Select defaultValue={a.model ?? "(default)"} disabled={ctrlDisabled} aria-label={`agent ${i + 1} model`} className="w-32">{NM_MODELS.map((mm) => <option key={mm}>{mm}</option>)}</Select>
                      </label>
                      <label className="inline-flex items-center gap-1 text-xs text-text-muted">effort
                        <Select defaultValue={a.effort ?? "medium"} disabled={ctrlDisabled} aria-label={`agent ${i + 1} effort`} className="w-24">{NM_EFFORTS.map((ef) => <option key={ef}>{ef}</option>)}</Select>
                      </label>
                      <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
                        <input type="checkbox" defaultChecked={a.lazy} disabled={ctrlDisabled || a.role === "router"} aria-label={`agent ${i + 1} lazy`} className="accent-accent" /> lazy
                      </label>
                      {a.harness === "opencode" ? (
                        <label className="inline-flex items-center gap-1 text-xs text-text-muted">permission
                          <Select defaultValue={a.opencodePermission ?? "ask"} disabled={ctrlDisabled} aria-label={`agent ${i + 1} opencode permission`} className="w-20"><option>ask</option><option>allow</option></Select>
                        </label>
                      ) : null}
                    </div>
                    {/* line 4: instructions + expand */}
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-text-muted">instructions (max 4000)</span>
                        <Button variant="ghost" size="sm" disabled={ctrlDisabled} aria-label={`expand agent ${i + 1} instructions`}>⤢ expand</Button>
                      </div>
                      <Textarea defaultValue={a.instructions ?? ""} disabled={ctrlDisabled} rows={2} aria-label={`agent ${i + 1} instructions`} placeholder="per-agent instructions injected into this agent's briefing…" />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <span className="text-xs uppercase tracking-wider text-text-muted">auto-compact</span>
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-1.5 text-sm text-text-secondary">
                <input type="checkbox" defaultChecked disabled={ctrlDisabled} aria-label="auto-compact enabled" className="accent-accent" /> enable auto-compact
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs text-text-muted">threshold
                <Input defaultValue="85%" disabled={ctrlDisabled} aria-label="auto-compact threshold" className="w-20" />
              </label>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-text-muted">mail edges · {f.edges.length}</span>
              <Button variant="secondary" size="sm" disabled={ctrlDisabled}>+ Add edge</Button>
            </div>
            <p className="text-xs text-text-muted">{mobile ? "from / to pickers (drawing is desktop-only); steer = can interject" : "declare or draw who can mail whom; steer = can interject"}</p>
            <div className="flex flex-col gap-1.5">
              {f.edges.length === 0 ? <span className="text-xs text-text-muted">no edges yet</span> : f.edges.map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <Select defaultValue={e.from} disabled={ctrlDisabled} aria-label={`edge ${i + 1} from`} className="flex-1">{f.agents.map((a) => <option key={a.id}>{a.id}</option>)}</Select>
                  <span aria-hidden="true" className="text-text-muted">→</span>
                  <Select defaultValue={e.to} disabled={ctrlDisabled} aria-label={`edge ${i + 1} to`} className="flex-1">{f.agents.map((a) => <option key={a.id}>{a.id}</option>)}</Select>
                  <label className="inline-flex shrink-0 items-center gap-1 text-xs text-text-secondary">
                    <input type="checkbox" defaultChecked={i === 0} disabled={ctrlDisabled} aria-label={`edge ${i + 1} steer`} className="accent-accent" /> steer
                  </label>
                  <Button variant="ghost" size="sm" iconOnly aria-label={`remove edge ${i + 1}`} disabled={ctrlDisabled}>×</Button>
                </div>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs uppercase tracking-wider text-text-muted">charter (optional)</label>
              <Button variant="ghost" size="sm" disabled={ctrlDisabled} aria-label="expand charter">⤢ expand</Button>
            </div>
            <Textarea defaultValue={state === "empty" ? "" : "Ship the device-auth page and keep the gate fail-closed."} disabled={ctrlDisabled} rows={mobile ? 3 : 2} aria-label="charter" />
          </section>
        </div>
      </div>
      {nmEditor !== "off" ? <NmTextEditor kind={nmEditor} mobile={mobile} /> : null}
    </div>
  );
}

// ── desktop shell ────────────────────────────────────────────────────────────
interface ShellChrome {
  connection?: Connection;
  meshes?: { id: string; status: Status }[];
  navMode?: "rows" | "skeleton" | "empty";
  mutationsDisabled?: boolean;
  meshBusy?: boolean;
  notifCount?: number;
  banner?: ReactNode;
}

function DesktopShell({ view, setView, mesh, setMesh, meshHref, stage, contextTitle, context, connection = "connected", meshes = MESHES, navMode = "rows", mutationsDisabled = false, meshBusy = false, notifCount = 3, banner }: { view: View; setView: (v: View) => void; mesh: string; setMesh: (m: string) => void; meshHref: (id: string) => string; stage: ReactNode; contextTitle: string; context: ReactNode } & ShellChrome) {
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [ctxCollapsed, setCtxCollapsed] = useState(false);
  const [navPage, setNavPage] = useState(0);
  // Mesh-list pagination (audit #19): 4/page, clamp the page to the current count.
  const navPages = Math.max(1, Math.ceil(meshes.length / NAV_PER_PAGE));
  const pg = Math.min(navPage, navPages - 1);
  const shownMeshes = meshes.slice(pg * NAV_PER_PAGE, pg * NAV_PER_PAGE + NAV_PER_PAGE);
  return (
    <div data-mockup="frame" data-device="desktop" className="w-[1280px] max-w-full overflow-hidden rounded-xl border border-border bg-surface text-text-primary shadow-sm">
      {/* topbar */}
      <header className="flex items-center gap-3 border-b border-border bg-surface-raised px-4 py-2.5">
        <Brand />
        <ConnectionChip connection={connection} />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        {/* Adaptive mesh control: when the left nav is expanded it IS the primary mesh
            switcher, so the topbar shows the current mesh as a non-interactive label.
            When the nav is collapsed (list hidden), the topbar falls back to a select.
            busy → spinner; mutations disabled → select disabled. */}
        {navCollapsed ? (
          <label data-topbar-mesh="select" className="inline-flex items-center gap-1.5 text-sm">
            <span className="text-text-muted">mesh</span>
            <select value={mesh} disabled={mutationsDisabled} onChange={(e) => setMesh(e.target.value)} aria-label="active mesh" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary disabled:text-text-disabled disabled:cursor-not-allowed">
              {meshes.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </label>
        ) : (
          <span data-topbar-mesh="label" aria-label="current mesh" className="inline-flex items-center gap-1.5 text-sm">
            <span className="text-text-muted">mesh</span>
            <span className="max-w-[220px] truncate font-medium text-text-primary">{mesh}</span>
            {meshBusy ? <Spinner size={12} label="switching" /> : null}
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
        <Button variant="ghost" size="sm" iconOnly aria-label={`通知 (${notifCount} 未读)`} className="relative">
          🔔{notifCount > 0 ? <span className="absolute -right-1 -top-1"><Badge count={notifCount} max={99} tone="urgent" /></span> : null}
        </Button>
        <Button variant="ghost" size="sm" disabled={mutationsDisabled}>管理▾</Button>
        <Button variant="ghost" size="sm" disabled={mutationsDisabled}>设置▾</Button>
      </header>

      {banner ? <div className="border-b border-border">{banner}</div> : null}

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
          <nav aria-label="meshes" className="flex w-[232px] shrink-0 flex-col border-r border-border bg-surface-raised p-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="px-1 text-xs uppercase tracking-wider text-text-muted">meshes</span>
              <Cluster>
                {/* ↻ reload mesh definitions — two-click confirm (audit #20). */}
                <ConfirmButton variant="ghost" size="sm" iconOnly aria-label="重新加载 mesh 定义" confirmLabel="确认?" onConfirm={() => {}} disabled={mutationsDisabled}>↻</ConfirmButton>
                <Button variant="ghost" size="sm" iconOnly aria-label="收起导航" onClick={() => setNavCollapsed(true)}>«</Button>
              </Cluster>
            </div>
            {navMode === "skeleton" ? (
              <div className="flex flex-col gap-2 p-1">{[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="row" />)}</div>
            ) : navMode === "empty" ? (
              <div className="flex flex-1 flex-col">
                <EmptyState title="No meshes" description="Create your first mesh." />
                <div className="mt-auto"><Button variant="primary" size="sm" className="w-full">+ New mesh</Button></div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
                {/* Primary mesh switcher: each row is a real link-like affordance (RouteLink <a>). */}
                {shownMeshes.map((m) => (
                  <StatusListRow key={m.id} status={m.status} title={m.id} href={meshHref(m.id)} active={m.id === mesh} />
                ))}
                {/* Pagination — only when the list spills past one page (audit #19). */}
                {navPages > 1 ? (
                  <div data-mesh-pagination className="mt-1 flex items-center justify-center gap-2">
                    <Button variant="ghost" size="sm" iconOnly aria-label="上一页 mesh" disabled={pg === 0} onClick={() => setNavPage(Math.max(0, pg - 1))}>‹</Button>
                    <span className="text-xs tabular-nums text-text-muted">{pg + 1} / {navPages}</span>
                    <Button variant="ghost" size="sm" iconOnly aria-label="下一页 mesh" disabled={pg >= navPages - 1} onClick={() => setNavPage(Math.min(navPages - 1, pg + 1))}>›</Button>
                  </div>
                ) : null}
                <div className="mt-2"><Button variant="primary" size="sm" className="w-full" disabled={mutationsDisabled}>+ New mesh</Button></div>
              </div>
            )}
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

function MobileShell({ tab, setTab, mesh, setMesh, stage, stageTab, connection = "connected", meshes = MESHES, mutationsDisabled = false, notifCount = 3, banner }: { tab: MobileTab; setTab: (t: MobileTab) => void; mesh: string; setMesh: (m: string) => void; stage?: ReactNode; stageTab?: MobileTab } & ShellChrome) {
  return (
    <div data-mockup="frame" data-device="mobile" className="relative flex h-[760px] w-[390px] max-w-full flex-col overflow-hidden rounded-[28px] border border-border bg-surface text-text-primary shadow-sm">
      {/* slim topbar */}
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-3 py-2.5">
        <Brand />
        <ConnectionChip compact connection={connection} />
        <span className="flex-1" aria-hidden="true" />
        {/* No left nav on mobile, so the topbar always keeps the mesh select. */}
        <label data-topbar-mesh="select" className="inline-flex items-center">
          <select value={mesh} disabled={mutationsDisabled} onChange={(e) => setMesh(e.target.value)} aria-label="active mesh" className="max-w-[150px] rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary disabled:text-text-disabled disabled:cursor-not-allowed">
            {meshes.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
        </label>
      </header>

      {banner ? <div className="border-b border-border">{banner}</div> : null}

      {/* active view */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === "more" ? (
          <PanelFrame title="更多">
            <div className="flex flex-col gap-1">
              <StatusListRow status="attention" title="🔔 通知" meta={String(notifCount)} href="/__ui-mockup?device=mobile" trailing={<Badge count={notifCount} max={99} tone="urgent" />} />
              <StatusListRow status="ready" title="管理 · Assistant / Harnesses / Channels / Doctor" href="/__ui-mockup?device=mobile" />
              <StatusListRow status="ready" title="设置 · 主题 / 语言 / 鉴权 / 设备" href="/__ui-mockup?device=mobile" />
              {/* ↻ reload mesh definitions in the 更多 sheet — two-click confirm (audit #20). */}
              <div className="pt-1"><ConfirmButton variant="secondary" size="sm" className="w-full" aria-label="重新加载 mesh 定义" confirmLabel="再次点击确认重新加载" onConfirm={() => {}} disabled={mutationsDisabled}>↻ 重新加载 mesh 定义</ConfirmButton></div>
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
  p.set("state", s.state);
  p.set("nmEditor", s.nmEditor);
  if (s.boardFs) p.set("boardFs", "1");
  if (s.boardManage) p.set("boardManage", "1");
  if (s.asstFs) p.set("asstFs", "1");
  if (s.lb) p.set("lb", "1");
  if (s.index) p.set("index", "1");
  p.set("mesh", s.mesh);
  p.set("mode", s.mode);
  p.set("accent", s.accent);
  return p.toString();
}

// ── shell (01) state → chrome flags + stage content (Phase B) ────────────────────
const OfflineBanner = (
  <div role="status" className="flex items-center gap-2 bg-warning-subtle px-4 py-1.5 text-xs text-warning">
    <Spinner size={12} label="reconnecting" /> 连接已断开 — 正在重连…（变更已禁用，显示最近已知内容）
  </div>
);
const PermBanner = (
  <div role="status" className="bg-danger-subtle px-4 py-1.5 text-xs text-danger">
    设备未授权 — 管理与变更已禁用；请在「设置」批准本设备。只读浏览可用。
  </div>
);

function shellChromeFor(state: ShellState): ShellChrome {
  switch (state) {
    case "empty": return { navMode: "empty", notifCount: 0 };
    case "loading": return { connection: "connecting", navMode: "skeleton" };
    case "permission": return { mutationsDisabled: true, banner: PermBanner };
    case "busy": return { meshBusy: true };
    case "offline": return { connection: "offline", mutationsDisabled: true, banner: OfflineBanner };
    case "boundary": return { meshes: MANY_MESHES, notifCount: 250 };
    case "error":
    case "populated":
    default: return {};
  }
}

function ShellStage({ state, view = "runtime" }: { state: ShellState; view?: View }) {
  if (state === "empty") {
    return <PanelFrame title="运行态" className="h-full"><EmptyState icon={<span className="text-2xl">📭</span>} title="No meshes yet" description="Create your first mesh to get started." action={<Button variant="primary">+ New mesh</Button>} /></PanelFrame>;
  }
  if (state === "loading") {
    return <PanelFrame title="运行态" className="h-full"><div className="flex flex-col gap-3"><Skeleton variant="line" /><Skeleton variant="row" /><Skeleton variant="card" /></div></PanelFrame>;
  }
  if (state === "error") {
    return <PanelFrame title="运行态" className="h-full"><ErrorBanner title="Failed to load mesh" onRetry={() => {}}>The snapshot request failed — the chrome stays usable.</ErrorBanner></PanelFrame>;
  }
  if (state === "offline") {
    return <PanelFrame title="运行态" className="h-full"><p className="text-sm text-text-secondary">显示最近已知内容；连接恢复后自动刷新。变更操作在离线时禁用。</p></PanelFrame>;
  }
  if (state === "permission") {
    return <PanelFrame title="运行态" className="h-full"><p className="text-sm text-text-secondary">只读浏览可用；创建/管理/生命周期操作需已授权设备（见顶部横幅）。</p></PanelFrame>;
  }
  return <StagePlaceholder view={view} />;
}

// ── navigation / index skeleton (Phase B unified review) ─────────────────────────
// A route-guarded directory of every implemented surface + its state/device deep
// links. Skeleton: extended per surface as later Phase-B补漏 checkpoints land.
const INDEX_TONE = "dark-slate&accent=signal-teal";
type IndexRow = { label: string; base: string; states: ShellState[]; mobile: boolean };
const INDEX_SECTIONS: { title: string; note: string; rows: IndexRow[] }[] = [
  { title: "01 · 应用外壳", note: "topbar · 自适应 mesh 控件 · 左导航（分页 4/页 + ↻ 重载定义）· stage · 右上下文", rows: [
    { label: "shell（含分页见 boundary / ↻ 重载见各态）", base: "surface=shell", states: SHELL_STATES, mobile: true },
  ] },
  { title: "02 · 运行态 A", note: "topology overview · focused transcript · fullscreen · canvas", rows: [
    { label: "overview", base: "surface=runtime&runtime=overview", states: SHELL_STATES, mobile: true },
    { label: "focus", base: "surface=runtime&runtime=focus", states: SHELL_STATES, mobile: true },
    { label: "full (桌面)", base: "surface=runtime&runtime=full", states: ["populated", "boundary", "permission", "offline", "empty", "loading", "error"], mobile: false },
    { label: "canvas (桌面)", base: "surface=runtime&runtime=canvas", states: ["populated", "boundary", "permission", "offline"], mobile: false },
  ] },
  { title: "03 · 看板 C", note: "list / detail / kanban · 全屏 🗖 · 按 Epic 分组 · 标签 CRUD+调色 · 建 Epic · reopen", rows: [
    { label: "list", base: "surface=board&board=list", states: SHELL_STATES, mobile: true },
    { label: "detail", base: "surface=board&board=detail", states: SHELL_STATES, mobile: true },
    { label: "kanban (桌面)", base: "surface=board&board=kanban", states: SHELL_STATES, mobile: false },
    { label: "list · 管理标签 (桌面)", base: "surface=board&board=list&boardManage=1", states: ["populated", "permission", "offline", "boundary"], mobile: false },
    { label: "list · 全屏 (桌面)", base: "surface=board&board=list&boardFs=1", states: ["populated", "boundary"], mobile: false },
    { label: "kanban · 全屏 (桌面)", base: "surface=board&board=kanban&boardFs=1", states: ["populated", "boundary"], mobile: false },
  ] },
  { title: "04 · 新建 mesh", note: "builder: agents / edges / charter / per-agent controls", rows: [
    { label: "builder", base: "surface=new-mesh", states: ["empty", "populated", "error", "permission", "busy", "offline", "boundary"], mobile: true },
  ] },
  { title: "05 · Mesh Assistant B", note: "NL 控制器对话 · tool-call 卡片 · 删除确认 · 全屏 ⊞ · p2p DM 入口", rows: [
    { label: "chat", base: "surface=assistant", states: SHELL_STATES, mobile: true },
    { label: "chat · 全屏 (桌面)", base: "surface=assistant&asstFs=1", states: ["populated", "boundary"], mobile: false },
  ] },
  { title: "06 · Harnesses", note: "适配器安装/健康/双版本 · 安装进度(重试/关闭) · 自助安装 · 旧版本重启(after-idle/force/cancel)", rows: [
    { label: "panel", base: "surface=harnesses", states: ["loading", "populated", "error", "permission", "busy", "offline", "boundary"], mobile: true },
  ] },
  { title: "07 · Channels", note: "飞书状态/绑定 chat→mesh(provision) · 待审批发送者 authcode 入册 · allowSenders 注册表/撤销", rows: [
    { label: "panel", base: "surface=channels", states: SHELL_STATES, mobile: true },
  ] },
  { title: "08 · Doctor / 系统", note: "doctor 检查(host-key/port/deps/config/orphan/service) · ps daemon 表 · 恢复(reap 孤儿/restart daemon) · copy 诊断", rows: [
    { label: "panel", base: "surface=doctor", states: SHELL_STATES, mobile: true },
  ] },
  { title: "09 · Settings", note: "外观(mode×accent 3×3 + 自定义调色板) · 语言 · 默认视图/设备偏好 · 设备授权(approve/revoke/bootstrap)", rows: [
    { label: "panel", base: "surface=settings", states: SHELL_STATES, mobile: true },
  ] },
  { title: "10 · Notifications", note: "跨 mesh 通知中心 · 未读徽标 · 抽屉/列表 · 标记已读/全部 · 历史 · 跟随动作(→harnesses/doctor/settings)", rows: [
    { label: "center", base: "surface=notifications", states: SHELL_STATES, mobile: true },
  ] },
  { title: "11 · File / Artifact viewer", note: "渲染 md/code/image · 返回对话 · 图片 lightbox 缩放 · composer 待发送图片托盘", rows: [
    { label: "viewer", base: "surface=artifact", states: SHELL_STATES, mobile: true },
    { label: "viewer · lightbox", base: "surface=artifact&lb=1", states: ["populated", "boundary", "offline"], mobile: true },
  ] },
  { title: "12 · Device-auth 门禁", note: "未授权落地：设备码+宿主CLI批准 · 轮询 · bootstrap 令牌(仅body) · 过期重试 · 批准后回深链", rows: [
    { label: "gate", base: "surface=device-auth", states: ["loading", "permission", "error", "busy", "offline", "boundary"], mobile: true },
  ] },
];

function MockupIndex({ backHref }: { backHref: string }) {
  const dl = (base: string, device: Device, state: ShellState) =>
    `/__ui-mockup?${base}&device=${device}&state=${state}&mode=${INDEX_TONE}`;
  return (
    <div data-mockup-index className="mx-auto flex w-full max-w-[1100px] flex-col gap-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">每个 surface 的已实现状态 / 设备深链（fixture-only · 路由受 <code className="text-syntax-string">MESH_UI_PREVIEW</code> 保护）。</p>
        <LinkButton href={backHref} label="back to mockup">← 返回 mockup</LinkButton>
      </div>
      {INDEX_SECTIONS.map((sec) => (
        <section key={sec.title} className="rounded-xl border border-border bg-surface-raised p-4">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-text-primary">{sec.title}</h2>
            <span className="text-xs text-text-muted">{sec.note}</span>
          </div>
          <div className="flex flex-col gap-2">
            {sec.rows.map((row) => (
              <div key={row.label} className="flex flex-col gap-1 border-t border-border pt-2 first:border-0 first:pt-0">
                <span className="text-xs font-medium uppercase tracking-wider text-text-secondary">{row.label}</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-text-muted">桌面:</span>
                  {row.states.map((st) => <LinkButton key={st} href={dl(row.base, "desktop", st)}>{st}</LinkButton>)}
                </div>
                {row.mobile ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-text-muted">移动:</span>
                    {row.states.map((st) => <LinkButton key={st} href={dl(row.base, "mobile", st)}>{st}</LinkButton>)}
                  </div>
                ) : <span className="text-xs text-text-muted">移动: —（桌面专属）</span>}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function UiMockup() {
  const [sel, setSel] = useState<Sel>(readSel);
  const { device, view, surface, runtime, board, state, nmEditor, boardFs, boardManage, asstFs, lb, index, mesh, mode, accent } = sel;
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
  // Runtime sub-view deep links (focus → fullscreen; overview → canvas; and back).
  const fullHref = `/__ui-mockup?${selQuery({ ...sel, surface: "runtime", runtime: "full" })}`;
  const canvasHref = `/__ui-mockup?${selQuery({ ...sel, surface: "runtime", runtime: "canvas" })}`;
  const focusBackHref = `/__ui-mockup?${selQuery({ ...sel, surface: "runtime", runtime: "focus" })}`;
  const overviewHref = `/__ui-mockup?${selQuery({ ...sel, surface: "runtime", runtime: "overview" })}`;
  const indexBackHref = `/__ui-mockup?${selQuery({ ...sel, index: false })}`;
  // Board sub-view deep links: fullscreen enter/exit + label-manager toggle.
  const boardFsHref = `/__ui-mockup?${selQuery({ ...sel, surface: "board", boardFs: true })}`;
  const boardExitFsHref = `/__ui-mockup?${selQuery({ ...sel, surface: "board", boardFs: false })}`;
  const boardManageHref = `/__ui-mockup?${selQuery({ ...sel, surface: "board", boardManage: !boardManage })}`;
  // Assistant chat fullscreen enter/exit (audit #21).
  const asstFsHref = `/__ui-mockup?${selQuery({ ...sel, surface: "assistant", asstFs: !asstFs })}`;
  // Artifact viewer: lightbox enter/exit + back-to-conversation.
  const artifactLbHref = `/__ui-mockup?${selQuery({ ...sel, surface: "artifact", lb: true })}`;
  const artifactExitLbHref = `/__ui-mockup?${selQuery({ ...sel, surface: "artifact", lb: false })}`;
  const artifactBackHref = `/__ui-mockup?${selQuery({ ...sel, surface: "runtime", runtime: "focus" })}`;
  const setMesh = (m: string) => nav({ mesh: m });

  const setView = (v: View) => {
    nav({ view: v });
    if (v === "board" || v === "runtime") setMobileTab(v);
  };

  // Stage + right-context content: the empty shell placeholder, the runtime (A)
  // mockup, or the board (C) mockup.
  const desktopStage = surface === "runtime"
    ? (runtime === "focus" ? <RuntimeFocusDesktop state={state} fullHref={fullHref} /> : <RuntimeOverviewDesktop focusHref={focusHref} canvasHref={canvasHref} state={state} />)
    : surface === "board"
    ? (board === "detail" ? <BoardDetailDesktop state={state} fsHref={boardFsHref} /> : board === "kanban" ? <BoardKanbanDesktop state={state} fsHref={boardFsHref} /> : <BoardListDesktop state={state} fsHref={boardFsHref} manage={boardManage} manageHref={boardManageHref} />)
    : <ShellStage state={state} view={view} />;
  // Runtime + board share the same chrome-by-state behavior (mesh nav stays populated).
  const shellChrome: ShellChrome = surface === "shell" ? shellChromeFor(state) : (surface === "runtime" || surface === "board") ? runtimeChromeFor(state) : {};
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

  // Mobile functional stage (runtime / board / shell-state); shown in the runtime/board tab.
  // Mobile has no split to expand and no canvas → full degrades to focus, canvas to list.
  const mobileStage = surface === "runtime"
    ? ((runtime === "focus" || runtime === "full") ? <RuntimeFocusMobile state={state} /> : <RuntimeListMobile focusHref={focusHref} state={state} />)
    : surface === "board"
    ? (board === "detail" ? <BoardDetailMobile state={state} /> : <BoardListMobile state={state} />)
    : <ShellStage state={state} />;
  const mobileStageTab: MobileTab = surface === "board" ? "board" : "runtime";

  return (
    <div data-mockup="root" className="min-h-screen bg-surface text-text-primary font-sans p-6">
      {/* mockup tool chrome (outside the mocked app frame) */}
      <header className="mb-5">
        <h1 className="mb-1 text-xl font-semibold">Agent Mesh — 终稿 mockup（{index ? "导航索引" : surface === "runtime" ? `运行态 A · ${runtime}` : surface === "board" ? "看板 C" : surface === "new-mesh" ? "新建 mesh" : surface === "assistant" ? "Mesh Assistant B" : surface === "harnesses" ? "Harnesses" : surface === "channels" ? "Channels" : surface === "doctor" ? "Doctor / 系统" : surface === "settings" ? "Settings" : surface === "notifications" ? "Notifications" : surface === "artifact" ? "File / Artifact" : surface === "device-auth" ? "Device-auth gate" : "应用外壳"}{index ? "" : ` · ${state} · ${device === "mobile" ? "移动" : "桌面"}`}）</h1>
        <p className="mb-3 text-xs text-text-muted">真实 C5–C7 组件 + v2 compose 运行时 · fixture 数据 · 不连后端。Live: <code className="text-syntax-string">MESH_UI_PREVIEW=1 … /__ui-mockup</code></p>
        <div className="mb-3">
          <SegmentedControl ariaLabel="View mode" value={index ? "index" : "mockup"} onChange={(v) => nav({ index: v === "index" })} options={[{ value: "mockup", label: "Mockup" }, { value: "index", label: "▤ 索引" }]} size="sm" />
        </div>
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
            <SegmentedControl ariaLabel="Surface" value={surface} onChange={(s) => { const next = s as Surface; nav({ surface: next }); if (next === "board") setMobileTab("board"); else if (next === "runtime") setMobileTab("runtime"); }} options={[{ value: "shell", label: "外壳" }, { value: "runtime", label: "运行态 A" }, { value: "board", label: "看板 C" }, { value: "assistant", label: "助手 B" }, { value: "harnesses", label: "Harness" }, { value: "channels", label: "渠道" }, { value: "doctor", label: "Doctor" }, { value: "settings", label: "设置" }, { value: "notifications", label: "通知" }, { value: "artifact", label: "产物" }, { value: "device-auth", label: "鉴权" }, { value: "new-mesh", label: "新建" }]} size="sm" />
          </div>
          {surface === "runtime" ? (
            <div>
              <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">Runtime view</div>
              <SegmentedControl
                ariaLabel="Runtime view"
                value={runtime}
                onChange={(r) => nav({ runtime: r as RuntimeState })}
                options={device === "mobile"
                  ? [{ value: "overview", label: "Overview" }, { value: "focus", label: "Focus" }]
                  : [{ value: "overview", label: "Overview" }, { value: "focus", label: "Focus" }, { value: "full", label: "Full" }, { value: "canvas", label: "Canvas" }]}
                size="sm"
              />
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
          {surface === "shell" || surface === "runtime" || surface === "board" || surface === "new-mesh" || surface === "assistant" || surface === "harnesses" || surface === "channels" || surface === "doctor" || surface === "settings" || surface === "notifications" || surface === "artifact" || surface === "device-auth" ? (
            <div>
              <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">State</div>
              <SegmentedControl
                ariaLabel="State"
                value={state}
                onChange={(s) => nav({ state: s as ShellState })}
                options={(surface === "new-mesh" ? (["empty", "populated", "error", "permission", "busy", "offline", "boundary"] as ShellState[])
                  : surface === "harnesses" ? (["loading", "populated", "error", "permission", "busy", "offline", "boundary"] as ShellState[])
                  : SHELL_STATES).map((s) => ({ value: s, label: s }))}
                size="sm"
              />
            </div>
          ) : null}
          {surface === "new-mesh" ? (
            <div>
              <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">Expanded editor</div>
              <SegmentedControl ariaLabel="Expanded editor" value={nmEditor} onChange={(e) => nav({ nmEditor: e as NmEditor })} options={[{ value: "off", label: "off" }, { value: "charter", label: "charter" }, { value: "instructions", label: "instructions" }]} size="sm" />
            </div>
          ) : null}
          {surface === "assistant" && device === "desktop" ? (
            <div>
              <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">Chat fullscreen</div>
              <SegmentedControl ariaLabel="Chat fullscreen" value={asstFs ? "on" : "off"} onChange={(v) => nav({ asstFs: v === "on" })} options={[{ value: "off", label: "off" }, { value: "on", label: "⊞ full" }]} size="sm" />
            </div>
          ) : null}
          {surface === "artifact" ? (
            <div>
              <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">Lightbox</div>
              <SegmentedControl ariaLabel="Lightbox" value={lb ? "on" : "off"} onChange={(v) => nav({ lb: v === "on" })} options={[{ value: "off", label: "off" }, { value: "on", label: "🔍 zoom" }]} size="sm" />
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex justify-center">
        {index
          ? <MockupIndex backHref={indexBackHref} />
          : surface === "assistant"
          ? <AssistantFrame state={state} device={device} fs={device === "desktop" && asstFs} fsHref={asstFsHref} />
          : surface === "harnesses"
          ? <HarnessesFrame state={state} device={device} />
          : surface === "channels"
          ? <ChannelsFrame state={state} device={device} />
          : surface === "doctor"
          ? <DoctorFrame state={state} device={device} />
          : surface === "settings"
          ? <SettingsFrame state={state} device={device} mode={mode} accent={accent} onMode={(m) => nav({ mode: m })} onAccent={(a) => nav({ accent: a })} />
          : surface === "notifications"
          ? <NotificationsFrame state={state} device={device} mode={mode} accent={accent} />
          : surface === "artifact"
          ? <FileViewerFrame state={state} device={device} lb={lb} lbHref={artifactLbHref} exitLbHref={artifactExitLbHref} backHref={artifactBackHref} />
          : surface === "device-auth"
          ? <DeviceAuthFrame state={state} device={device} />
          : surface === "new-mesh"
          ? <NewMeshFrame state={state} device={device} nmEditor={nmEditor} />
          : surface === "runtime" && device === "desktop" && runtime === "full"
          ? <RuntimeFullFrame state={state} backHref={focusBackHref} />
          : surface === "runtime" && device === "desktop" && runtime === "canvas"
          ? <MeshCanvasFrame state={state} backHref={overviewHref} />
          : surface === "board" && device === "desktop" && boardFs
          ? <BoardFullFrame board={board} state={state} backHref={boardExitFsHref} manage={boardManage} manageHref={boardManageHref} />
          : device === "mobile"
          ? <MobileShell tab={mobileTab} setTab={(t) => { setMobileTab(t); if (t === "runtime" || t === "board") nav({ view: t }); }} mesh={mesh} setMesh={setMesh} stage={mobileStage} stageTab={mobileStageTab} {...shellChrome} />
          : <DesktopShell view={view} setView={setView} mesh={mesh} setMesh={setMesh} meshHref={meshHref} stage={desktopStage} contextTitle={contextTitle} context={desktopContext} {...shellChrome} />}
      </div>
    </div>
  );
}
