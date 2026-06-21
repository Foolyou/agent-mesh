// Step 6 — the application-shell mockup renders from the REAL ui/ components with
// fixture data. SSR assertions (useEffect/applyComposition don't run under
// renderToStaticMarkup; readSel() guards on `typeof window`). Browser behavior
// (view switch, device deep link, screenshots) lives in src/web/ui-mockup.e2e.ts.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UiMockup } from "./UiMockup";

const desktop = renderToStaticMarkup(<UiMockup />);

/** Render the mockup as if loaded at a given query (readSel reads window.location.search). */
function renderAt(search: string): string {
  const g = globalThis as any;
  const prev = g.window;
  g.window = { location: { search } };
  try {
    return renderToStaticMarkup(<UiMockup />);
  } finally {
    g.window = prev;
  }
}

test("desktop shell: adaptive topbar (label while nav expanded) + view switcher + nav + stage", () => {
  expect(desktop).toContain('data-mockup="root"');
  expect(desktop).toContain('data-device="desktop"');
  // Nav expanded by default → topbar mesh control is a non-interactive LABEL, not a select.
  expect(desktop).toContain('data-topbar-mesh="label"');
  expect(desktop).not.toContain('data-topbar-mesh="select"');
  expect(desktop).not.toContain('aria-label="active mesh"'); // no topbar select while nav expanded
  expect(desktop).toContain('role="radiogroup"'); // SegmentedControl view switcher
  expect(desktop).toContain("运行态");
  expect(desktop).toContain("看板");
  expect(desktop).toContain("管理▾");
  expect(desktop).toContain("设置▾");
  expect(desktop).toContain("+ New mesh");
  expect(desktop).toContain('aria-label="meshes"'); // left nav (primary mesh switcher)
  expect(desktop).toContain('aria-label="context"'); // right context
  expect(desktop).toContain("dev-mesh"); // fixture mesh
  expect(desktop).toContain('href="/__ui-mockup?'); // mesh rows are real link affordances
  expect(desktop).toContain("视图占位"); // stage placeholder
});

test("mobile shell: slim topbar + bottom tabs 运行态·看板·更多", () => {
  const mobile = renderAt("?device=mobile");
  expect(mobile).toContain('data-device="mobile"');
  expect(mobile).toContain('role="tablist"');
  expect((mobile.match(/role="tab"/g) ?? []).length).toBe(3);
  expect(mobile).toContain("更多");
  expect(mobile).toContain('aria-label="active mesh"'); // selector kept in slim topbar
});

test("runtime A · desktop overview: topology of agents with approval red-dot/count", () => {
  const out = renderAt("?device=desktop&surface=runtime&runtime=overview");
  expect(out).toContain('data-runtime="overview"');
  expect(out).toContain("Topology");
  expect(out).toContain("router");
  expect(out).toContain("codex-1");
  expect(out).toContain("Topology detail"); // right context title for overview
  // pending approvals surface as urgent badges (codex-1=1, claude-1=2)
  expect(out).toContain("bg-danger");
});

test("runtime A · desktop focus: transcript + inline ApprovalCard + Composer + activity/mail context", () => {
  const out = renderAt("?device=desktop&surface=runtime&runtime=focus");
  expect(out).toContain('data-runtime="focus"');
  expect(out).toContain("restart the alpha mesh"); // transcript fixture
  expect(out).toContain("Allow"); // inline ApprovalCard
  expect(out).toContain("Approve");
  expect(out).toContain("Deny");
  expect(out).toContain('aria-label="Message composer"'); // Composer shell
  expect(out).toContain("activity"); // right context for focused agent
  expect(out).toContain("mail");
});

test("runtime A · mobile overview: agent card list with pending approvals pinned on top", () => {
  const out = renderAt("?device=mobile&surface=runtime&runtime=overview");
  expect(out).toContain('data-device="mobile"');
  expect(out).toContain('data-runtime="overview"');
  expect(out).toContain("待审批"); // pinned approvals section
  expect(out).toContain("Agents");
  expect(out).toContain("codex-1");
});

test("runtime A · mobile focus (C2): approval is a docked bar below transcript, above composer", () => {
  const out = renderAt("?device=mobile&surface=runtime&runtime=focus");
  expect(out).toContain('data-runtime="focus"');
  expect(out).toContain("data-approval-bar"); // docked approval bar (not inline)
  expect(out).toContain("Allow");
  expect(out).toContain("Transcript");
  expect(out).toContain('aria-label="Message composer"');
  // C2: approval docks BELOW the transcript and ABOVE the composer
  expect(out.indexOf("Transcript")).toBeLessThan(out.indexOf("data-approval-bar"));
  expect(out.indexOf("data-approval-bar")).toBeLessThan(out.indexOf('aria-label="Message composer"'));
});

test("board C · desktop list: filter/sort bar, bulk toolbar, epic groups, rich issue rows", () => {
  const out = renderAt("?device=desktop&surface=board&board=list");
  expect(out).toContain('data-board="list"');
  expect(out).toContain('aria-label="search issues"'); // query/filter bar
  expect(out).toContain('aria-label="sort"');
  expect(out).toContain('aria-label="select all"'); // bulk toolbar
  expect(out).toContain("Epic: Onboarding"); // epic group header (aggregation)
  expect(out).toContain("#12");
  expect(out).toContain("Add device-auth page");
  expect(out).toContain("⛔"); // blocked indicator
  expect(out).toContain('role="progressbar"'); // subtask progress
  expect(out).toContain("Dispatch ▾"); // router dispatch entry
  expect(out).toContain("open · "); // open/closed counts
});

test("board C · desktop detail: meta + lifecycle path + subtasks + deps + timeline + comment", () => {
  const out = renderAt("?device=desktop&surface=board&board=detail");
  expect(out).toContain('data-board="detail"');
  expect(out).toContain("#12");
  expect(out).toContain("epic: Onboarding");
  expect(out).toContain("in_progress"); // lifecycle auto-flow path strip
  expect(out).toContain("activity timeline");
  expect(out).toContain("review_requested → in_review"); // lifecycle history
  expect(out).toContain("blocked-by"); // deps
  expect(out).toContain('aria-label="Message composer"'); // comment box
});

test("board C · desktop kanban: lifecycle columns + condensed cards", () => {
  const out = renderAt("?device=desktop&surface=board&board=kanban");
  expect(out).toContain('data-board="kanban"');
  for (const col of ["todo", "in_progress", "in_review", "done", "cancelled"]) {
    expect(out).toContain(col);
  }
  expect(out).toContain("#12"); // a card
});

test("board C · mobile list + detail (kanban is desktop-only)", () => {
  const list = renderAt("?device=mobile&surface=board&board=list");
  expect(list).toContain('data-device="mobile"');
  expect(list).toContain('data-board="list"');
  expect(list).toContain("#12");
  expect(list).toContain('aria-label="search issues"');
  const detail = renderAt("?device=mobile&surface=board&board=detail");
  expect(detail).toContain('data-board="detail"');
  expect(detail).toContain("Activity");
  expect(detail).toContain('aria-label="Message composer"');
  // kanban on mobile degrades to the list (desktop-only)
  expect(renderAt("?device=mobile&surface=board&board=kanban")).toContain('data-board="list"');
});

// ── shell (01) states (Phase B) ──────────────────────────────────────────────
test("shell state · empty: no-mesh empty state + New mesh CTA", () => {
  const out = renderAt("?surface=shell&state=empty&device=desktop");
  expect(out).toContain("No meshes yet");
  expect(out).toContain("+ New mesh");
});

test("shell state · loading: skeletons + connecting chip", () => {
  const out = renderAt("?surface=shell&state=loading&device=desktop");
  expect(out).toContain("animate-pulse"); // Skeleton
  expect(out).toContain("connecting"); // ConnectionChip
});

test("shell state · error: ErrorBanner in stage, chrome still present", () => {
  const out = renderAt("?surface=shell&state=error&device=desktop");
  expect(out).toContain('role="alert"');
  expect(out).toContain("Failed to load mesh");
  expect(out).toContain('aria-label="meshes"'); // chrome usable
});

test("shell state · offline: offline chip + reconnecting banner + disabled mutations", () => {
  const out = renderAt("?surface=shell&state=offline&device=desktop");
  expect(out).toContain("offline");
  expect(out).toContain("正在重连");
  expect(out).toContain("disabled"); // 管理/设置/New mesh disabled
});

test("shell state · permission: unauthorized banner + disabled management", () => {
  const out = renderAt("?surface=shell&state=permission&device=desktop");
  expect(out).toContain("设备未授权");
  expect(out).toContain("disabled");
});

test("shell state · busy: mesh-switch spinner", () => {
  const out = renderAt("?surface=shell&state=busy&device=desktop");
  expect(out).toContain('aria-label="switching"'); // Spinner on mesh control
});

test("shell state · boundary: many meshes incl long name + badge overflow 99+", () => {
  const out = renderAt("?surface=shell&state=boundary&device=desktop");
  expect(out).toContain("a-very-long-mesh-name-that-should-truncate-gracefully");
  expect(out).toContain("99+"); // notif badge overflow (count 250, max 99)
  expect(out).toContain("truncate"); // long-name truncation class
});

test("shell state · mobile offline: slim topbar offline + banner", () => {
  const out = renderAt("?surface=shell&state=offline&device=mobile");
  expect(out).toContain('data-device="mobile"');
  expect(out).toContain("offline");
  expect(out).toContain("正在重连");
});

// ── app-shell补漏 — audited [E] capabilities (audit #19 pagination, #20 reload) ──
test("app-shell补漏 · desktop nav has ↻ reload (two-click); populated = single page (no pager)", () => {
  const out = renderAt("?surface=shell&state=populated&device=desktop");
  expect(out).toContain('aria-label="重新加载 mesh 定义"'); // reload definitions (#20)
  // 4 fixture meshes = exactly one page → no pagination control shown (matches Sidebar)
  expect(out.includes("data-mesh-pagination")).toBe(false);
});

test("app-shell补漏 · boundary paginates the mesh list (4/page, ‹ ›, page indicator)", () => {
  const out = renderAt("?surface=shell&state=boundary&device=desktop");
  expect(out).toContain("data-mesh-pagination"); // pagination present (#19)
  expect(out).toContain('aria-label="上一页 mesh"');
  expect(out).toContain('aria-label="下一页 mesh"');
  expect(out).toContain("1 / 4"); // 13 meshes / 4 per page
  // page 0 still carries the long name (reordered fixture) → truncation visible
  expect(out).toContain("a-very-long-mesh-name-that-should-truncate-gracefully");
  // page 0 shows exactly 4 rows → a later-page-only mesh is NOT in the initial markup
  expect(out.includes("security-audit")).toBe(false);
});

test("app-shell补漏 · offline/permission disable reload (mutations gated)", () => {
  expect(renderAt("?surface=shell&state=offline&device=desktop")).toContain('aria-label="重新加载 mesh 定义" disabled=""');
  expect(renderAt("?surface=shell&state=permission&device=desktop")).toContain('aria-label="重新加载 mesh 定义" disabled=""');
});

// ── runtime (02) states (Phase B) ────────────────────────────────────────────
test("runtime overview state · empty/loading/error stand-ins", () => {
  expect(renderAt("?surface=runtime&runtime=overview&state=empty")).toContain('data-runtime-state="empty"');
  expect(renderAt("?surface=runtime&runtime=overview&state=loading")).toContain("animate-pulse");
  const err = renderAt("?surface=runtime&runtime=overview&state=error");
  expect(err).toContain('role="alert"');
  expect(err).toContain('aria-label="meshes"'); // shell still works
});

test("runtime focus state · permission disables composer + approval; offline note", () => {
  const perm = renderAt("?surface=runtime&runtime=focus&state=permission");
  expect(perm).toContain("只读浏览"); // read-only note
  expect(perm).toContain("composer disabled");
  expect(perm).toContain("设备未授权"); // shell permission banner
  const off = renderAt("?surface=runtime&runtime=focus&state=offline");
  expect(off).toContain("显示最近已知内容");
  expect(off).toContain("正在重连"); // offline banner
});

test("runtime focus state · busy shows resolving/in-flight affordances", () => {
  const out = renderAt("?surface=runtime&runtime=focus&state=busy");
  expect(out).toContain('aria-busy="true"'); // ApprovalCard busy / Send busy spinner
});

test("runtime boundary · many agents (overview) + long transcript (focus)", () => {
  const ov = renderAt("?surface=runtime&runtime=overview&state=boundary&device=desktop");
  expect(ov).toContain("reviewer-1"); // a MANY_AGENTS-only agent
  expect(ov).toContain("13 agents · "); // count grows (AGENTS now incl. kimi-cold)
  const fo = renderAt("?surface=runtime&runtime=focus&state=boundary");
  expect(fo).toContain("exercise wrapping and truncation"); // long transcript line
});

test("runtime mobile · list pins approvals; focus docks approval below transcript (C2)", () => {
  const list = renderAt("?surface=runtime&runtime=overview&state=populated&device=mobile");
  expect(list).toContain('data-device="mobile"');
  expect(list).toContain("待审批"); // overview still pins the pending-approval section on top
  const focus = renderAt("?surface=runtime&runtime=focus&state=populated&device=mobile");
  expect(focus).toContain("Transcript");
  expect(focus).toContain("data-approval-bar");
  // C2: focus approval is docked AFTER the transcript (no longer pinned above it)
  expect(focus.indexOf("Transcript")).toBeLessThan(focus.indexOf("data-approval-bar"));
});

// ── runtime补漏 — audited [E] capabilities (audit #9–#18) ─────────────────────
test("runtime focus补漏 · selectors + context/health + queue + expanders + jump/load-older + ⊞ full", () => {
  const out = renderAt("?surface=runtime&runtime=focus&state=populated&device=desktop");
  expect(out).toContain('aria-label="agent mode"'); // mode/model/effort selectors (#10)
  expect(out).toContain('aria-label="agent model"');
  expect(out).toContain('aria-label="agent effort"');
  expect(out).toContain('aria-label="kimi thinking"'); // kimi-thinking (#10)
  expect(out).toContain("data-context-usage"); // context/health usage (#12)
  expect(out).toContain("ctx 62%");
  expect(out).toContain("silent-stop watch");
  expect(out).toContain("data-queue"); // pending-turn queue (#13)
  expect(out).toContain('aria-label="prev queued"');
  expect(out).toContain('aria-label="remove queued"');
  expect(out).toContain("data-transcript-expanders"); // expanders (#14)
  expect(out).toContain('aria-label="expand mail"');
  expect(out).toContain("data-load-older"); // load-older (#15)
  expect(out).toContain("data-jump-bottom"); // jump-to-bottom (#15)
  expect(out).toContain('aria-label="enter fullscreen"'); // ⊞ full link (#9)
});

test("runtime focus补漏 · near-limit context warning at boundary; permission disables selectors", () => {
  const b = renderAt("?surface=runtime&runtime=focus&state=boundary&device=desktop");
  expect(b).toContain("ctx 94%");
  expect(b).toContain("接近上限"); // near-limit warning
  const perm = renderAt("?surface=runtime&runtime=focus&state=permission&device=desktop");
  // selectors are disabled when unauthorized (disabled attr precedes aria-label)
  expect(perm).toContain('disabled="" aria-label="agent model"');
});

test("runtime overview补漏 · start strategy + add agent/edge + new-all + wake cold + canvas link", () => {
  const out = renderAt("?surface=runtime&runtime=overview&state=populated&device=desktop");
  expect(out).toContain('aria-label="start strategy"'); // resume/fresh (#18)
  expect(out).toContain('aria-label="add agent"'); // live add agent (#17)
  expect(out).toContain('aria-label="add edge"'); // live add edge (#17)
  expect(out).toContain('aria-label="new all sessions"'); // new-all-sessions (#18)
  expect(out).toContain('aria-label="wake kimi-cold"'); // wake cold/lazy agent (#11)
  expect(out).toContain('aria-label="open topology canvas"'); // ⤢ → canvas (#16)
});

test("runtime full补漏 · standalone fullscreen frame with ⊟ exit + transcript fills", () => {
  const out = renderAt("?surface=runtime&runtime=full&state=populated&device=desktop");
  expect(out).toContain('data-runtime="full"');
  expect(out).toContain('aria-label="exit fullscreen"'); // ⊟ exit (#9)
  expect(out).toContain("restart the alpha mesh"); // transcript present
  expect(out).toContain('aria-label="Message composer"');
  // empty state still renders inside the fullscreen frame
  expect(renderAt("?surface=runtime&runtime=full&state=empty&device=desktop")).toContain('data-runtime-state="empty"');
});

test("runtime canvas补漏 · zoomable canvas: windows + per-window stop/wake/actions + Esc close", () => {
  const out = renderAt("?surface=runtime&runtime=canvas&state=populated&device=desktop");
  expect(out).toContain('data-runtime="canvas"');
  expect(out).toContain("data-canvas-window"); // draggable/resizable windows (#16)
  expect(out).toContain("data-resize-handle");
  expect(out).toContain('aria-label="stop codex-1"'); // per-window stop
  expect(out).toContain('aria-label="wake kimi-cold"'); // per-window wake
  expect(out).toContain('aria-label="codex-1 actions"'); // actions menu
  expect(out).toContain('aria-label="close canvas"'); // Esc close
  expect(out).toContain('aria-label="zoom in"');
});

// ── C5: canvas information-flow edges + force-directed layout ──────────────────
test("canvas C5 · directed mail edges with arrowheads; recent traffic highlighted", () => {
  const out = renderAt("?surface=runtime&runtime=canvas&state=populated&device=desktop");
  expect(out).toContain("data-canvas-edges"); // SVG edge layer
  expect(out).toContain("data-canvas-edge"); // an edge line
  expect(out).toContain('id="arrow"'); // arrowhead marker (direction)
  expect(out).toContain('id="arrow-recent"'); // recent-edge arrowhead
  expect(out).toContain('data-edge-recent="true"'); // recent-mail edge highlighted
  expect(out).toContain("animate-pulse"); // recent edges pulse
  expect(out).toContain('marker-end="url(#arrow-recent)"'); // recent edge points its arrow
});

test("canvas C5 · force-directed toolbar (default-on) + 重新布局; existing controls intact", () => {
  const out = renderAt("?surface=runtime&runtime=canvas&state=populated&device=desktop");
  expect(out).toContain("data-canvas-autolayout"); // 力导向 toggle
  expect(out).toContain('aria-label="force-directed layout"');
  expect(out).toContain('checked=""'); // default-on
  expect(out).toContain("data-canvas-relayout"); // 重新布局
  expect(out).toContain('aria-label="重新布局"');
  // do not regress existing canvas controls
  for (const lbl of ["stop codex-1", "wake kimi-cold", "codex-1 actions", "close canvas", "zoom in"]) {
    expect(out).toContain(`aria-label="${lbl}"`);
  }
  expect(out).toContain("data-resize-handle");
});

test("canvas C5 · a dragged node is pinned (kept out of force-layout)", () => {
  const out = renderAt("?surface=runtime&runtime=canvas&state=populated&device=desktop");
  expect(out).toContain('data-canvas-pinned="true"'); // pinned node state
  expect(out).toContain("data-canvas-pin"); // 📌 marker
  expect(out).toContain('aria-label="codex-1 pinned"'); // the pinned (dragged) agent
});

test("canvas C5 · boundary scales edges + nodes (information flow stays legible)", () => {
  const out = renderAt("?surface=runtime&runtime=canvas&state=boundary&device=desktop");
  expect(out).toContain("data-canvas-edges");
  expect(out).toContain('data-edge-recent="true"'); // recent traffic still highlighted at scale
  // more nodes than the populated set
  expect(out).toContain('aria-label="reviewer-1 actions"'); // a boundary-only agent window
});

test("runtime补漏 mobile · full degrades to focus, canvas to list; controls present", () => {
  expect(renderAt("?surface=runtime&runtime=full&state=populated&device=mobile")).toContain('data-runtime="focus"');
  expect(renderAt("?surface=runtime&runtime=canvas&state=populated&device=mobile")).toContain('data-runtime="overview"');
  const focus = renderAt("?surface=runtime&runtime=focus&state=populated&device=mobile");
  expect(focus).toContain("data-context-usage"); // compact health on mobile
  expect(focus).toContain("data-queue");
  const ov = renderAt("?surface=runtime&runtime=overview&state=populated&device=mobile");
  expect(ov).toContain('aria-label="wake kimi-cold"'); // cold agent wake in mobile list
  expect(ov).toContain('aria-label="start strategy"');
});

// ── C2: approvals are a fixed composer-adjacent docked bar (FIFO + sticky + max-height) ──
test("C2 runtime focus desktop · docked approval bar below transcript, above composer; FIFO queue", () => {
  const out = renderAt("?surface=runtime&runtime=focus&state=populated&device=desktop");
  expect(out).toContain("data-approval-bar");
  expect(out).toContain("Approve"); // the oldest approval renders in the bar
  expect(out).toContain("data-approval-queue"); // FIFO: count of the rest
  expect(out).toContain("还有 2 个待授权"); // PENDING_APPROVALS(3) - 1
  // transcript content sits BEFORE the docked bar; composer AFTER it
  expect(out.indexOf("restart the alpha mesh")).toBeLessThan(out.indexOf("data-approval-bar"));
  expect(out.indexOf("data-approval-bar")).toBeLessThan(out.indexOf('aria-label="Message composer"'));
  // jump-to-latest is in the docked region (so the fixed bar+composer never hides it)
  expect(out.indexOf("data-jump-bottom")).toBeLessThan(out.indexOf("data-approval-bar"));
  // right-context approval-queue badge mirrors the FIFO count
  expect(out).toContain("data-context-approvals");
});

test("C2 runtime focus · long approval (boundary) is capped with internal scroll (no offscreen composer)", () => {
  const out = renderAt("?surface=runtime&runtime=focus&state=boundary&device=desktop");
  expect(out).toContain("data-approval-bar");
  expect(out).toContain("max-h-44"); // bar caps long content + overflow-auto
  expect(out).toContain("overflow-auto");
  expect(out).toContain("a long config.json change"); // LONG_APPROVAL_DIFF content
  // composer still present after the (capped) approval bar
  expect(out.indexOf("data-approval-bar")).toBeLessThan(out.indexOf('aria-label="Message composer"'));
});

test("C2 assistant · delete-confirm docks above composer (not inline); empty has none", () => {
  const out = renderAt("?surface=assistant&state=populated&device=desktop");
  expect(out).toContain("data-approval-bar");
  expect(out).toContain("Delete"); // delete-confirm inside the docked bar
  // docked bar sits after the conversation and before the composer
  expect(out.indexOf("now delete the scratch-del mesh")).toBeLessThan(out.indexOf("data-approval-bar"));
  expect(out.indexOf("data-approval-bar")).toBeLessThan(out.indexOf('aria-label="Message composer"'));
  // empty (suggestions) state has no approval bar
  expect(renderAt("?surface=assistant&state=empty&device=desktop").includes("data-approval-bar")).toBe(false);
});

test("C2 assistant mobile · docked confirm above composer", () => {
  const out = renderAt("?surface=assistant&state=populated&device=mobile");
  expect(out).toContain("data-approval-bar");
  expect(out.indexOf("data-approval-bar")).toBeLessThan(out.indexOf('aria-label="Message composer"'));
});

// ── navigation / index skeleton ──────────────────────────────────────────────
test("index skeleton · lists every surface with state/device deep links", () => {
  const out = renderAt("?index=1");
  expect(out).toContain("data-mockup-index");
  expect(out).toContain("01 · 应用外壳");
  expect(out).toContain("02 · 运行态 A");
  expect(out).toContain("03 · 看板 C");
  expect(out).toContain("04 · 新建 mesh");
  expect(out).toContain("05 · Mesh Assistant B");
  expect(out).toContain("06 · Harnesses");
  expect(out).toContain("07 · Channels");
  expect(out).toContain("08 · Doctor");
  expect(out).toContain("09 · Settings");
  expect(out).toContain("10 · Notifications");
  expect(out).toContain("11 · File / Artifact viewer");
  expect(out).toContain("12 · Device-auth 门禁");
  expect(out).toContain("13 · Global states");
  expect(out).toContain("data-index-overview"); // single entry-point overview sentence
  expect(out).toContain("浏览整套 Phase B mockup 的唯一入口");
  expect(out).toContain("surface=assistant"); // assistant deep links
  expect(out).toContain("surface=harnesses"); // harnesses deep links
  expect(out).toContain("surface=channels"); // channels deep links
  expect(out).toContain("surface=doctor"); // doctor deep links
  expect(out).toContain("surface=settings"); // settings deep links
  expect(out).toContain("surface=notifications"); // notifications deep links
  expect(out).toContain("surface=artifact"); // artifact deep links
  expect(out).toContain("surface=device-auth"); // device-auth deep links
  expect(out).toContain("surface=global"); // global-states deep links
  expect(out).toContain("runtime=canvas"); // a runtime补漏 deep link (& is HTML-escaped in href)
  expect(out).toContain("boardManage=1"); // board补漏 deep link
  expect(out).toContain("boardFs=1");
  expect(out).toContain("device=mobile"); // mobile links
  expect(out).toContain("← 返回 mockup");
  // index frame replaces the app frame
  expect(out.includes('data-mockup="frame"')).toBe(false);
});

// ── board补漏 — audited [E] capabilities (audit #22–#25) ───────────────────────
test("board list补漏 · group-by-epic + 管理标签 toggle + create epic/task + 全屏 toggle + reopen terminal", () => {
  // C4: group-by-epic moved into the 筛选▾ dropdown — open it to assert.
  const out = renderAt("?surface=board&board=list&state=populated&boardFilters=1&device=desktop");
  expect(out).toContain('aria-label="group by epic"'); // group-by-epic (#23, now in 筛选▾ menu)
  expect(out).toContain('data-board-manage-labels'); // 管理标签 toggle (#24)
  expect(out).toContain('data-board-create'); // create epic/task row (#25)
  expect(out).toContain('aria-label="new epic"');
  expect(out).toContain('aria-label="new task"');
  expect(out).toContain('data-board-fs'); // fullscreen toggle (#22)
  expect(out).toContain('aria-label="reopen #7"'); // reopen on a done issue (#25)
  expect(out).toContain('aria-label="reopen #5"'); // reopen on a cancelled issue
});

test("board list补漏 · ?boardManage=1 opens the label CRUD + palette manager", () => {
  const out = renderAt("?surface=board&board=list&state=populated&boardManage=1&device=desktop");
  expect(out).toContain("data-board-labels"); // LabelManager (#24)
  expect(out).toContain('aria-label="new label name"');
  expect(out).toContain('aria-label="add label"');
  expect(out).toContain('aria-label="rename auth"');
  expect(out).toContain('aria-label="recolor auth"'); // PalettePicker per label
  expect(out).toContain('aria-label="delete auth"');
  expect(out).toContain("data-palette"); // accessible palette swatches
  expect(out).toContain('aria-label="color #bae6fd"'); // a palette color
  // off by default
  expect(renderAt("?surface=board&board=list&state=populated").includes("data-board-labels")).toBe(false);
});

test("board补漏 · fullscreen frame (#22) is a standalone desktop frame with 🗕 exit", () => {
  const out = renderAt("?surface=board&board=list&state=populated&boardFs=1&device=desktop");
  expect(out).toContain('data-board-fs="1"'); // standalone fullscreen frame
  expect(out).toContain('aria-label="退出全屏"'); // 🗕 restore
  expect(out).toContain('data-board="list"'); // the board subview fills it
  // kanban fullscreen too
  expect(renderAt("?surface=board&board=kanban&state=populated&boardFs=1&device=desktop")).toContain('data-board="kanban"');
});

test("board detail补漏 · fs toggle present; reopen replaces close for terminal issues", () => {
  const det = renderAt("?surface=board&board=detail&state=populated&device=desktop");
  expect(det).toContain('data-board-fs'); // fullscreen toggle in detail (#22)
  // #12 (in_review, open) → close ▾, not reopen
  expect(det).toContain("close ▾");
  expect(det.includes('aria-label="reopen #12"')).toBe(false);
});

test("board补漏 · permission disables label manager + create + group-by-epic; offline too", () => {
  const perm = renderAt("?surface=board&board=list&state=permission&boardManage=1&boardFilters=1&device=desktop");
  expect(perm).toContain('disabled="" aria-label="new label name"'); // create-label input disabled
  expect(perm).toContain('disabled="" aria-label="group by epic"'); // checkbox disabled (in 筛选▾ menu)
  expect(renderAt("?surface=board&board=list&state=offline&device=desktop")).toContain('disabled="" aria-label="new epic"');
});

test("board补漏 mobile · group-by-epic in the filter row (fullscreen/manager are desktop-only)", () => {
  const out = renderAt("?surface=board&board=list&state=populated&device=mobile");
  expect(out).toContain('aria-label="group by epic"');
  // fullscreen flag is ignored on mobile (no standalone frame)
  expect(renderAt("?surface=board&board=list&state=populated&boardFs=1&device=mobile").includes('data-board-fs="1"')).toBe(false);
});

// ── C4: board filter area redesign (GH-Issues direction, desktop list) ─────────
test("board C4 · persistent search + 筛选▾ toggle + right-side action group (view/sort/新建)", () => {
  const out = renderAt("?surface=board&board=list&state=populated&device=desktop");
  expect(out).toContain('data-board-filters'); // filter area container
  expect(out).toContain('aria-label="search issues"'); // persistent search (token-style)
  expect(out).toContain("status:open label:bug"); // query-token hint in placeholder
  expect(out).toContain('data-board-filter-toggle'); // 筛选▾ dropdown affordance
  expect(out).toContain('aria-label="Board view"'); // view switch in the right action group
  expect(out).toContain('aria-label="sort"'); // sort in the right action group
  expect(out).toContain("+ 新建"); // 新建 in the right action group
  // status/label/assignee/epic pickers are NOT inline — they live in the closed 筛选▾ menu
  expect(out.includes('data-board-filter-menu')).toBe(false);
  expect(out.includes('aria-label="status filter"')).toBe(false);
});

test("board C4 · applied filters render as removable (×) chips with clear-all", () => {
  const out = renderAt("?surface=board&board=list&state=populated&device=desktop");
  expect(out).toContain('data-board-applied-filters');
  expect(out).toContain('data-filter-chip');
  expect(out).toContain("status:open"); // a chip token
  expect(out).toContain('aria-label="remove filter status"'); // per-chip × remove
  expect(out).toContain('aria-label="clear all filters"'); // clear-all
});

test("board C4 · 筛选▾ menu (?boardFilters=1) owns status/label/assignee/epic + group-by-epic", () => {
  const out = renderAt("?surface=board&board=list&state=populated&boardFilters=1&device=desktop");
  expect(out).toContain('data-board-filter-menu');
  expect(out).toContain('role="menu"');
  for (const lbl of ["status filter", "label filter", "assignee filter", "epic filter", "group by epic"]) {
    expect(out).toContain(`aria-label="${lbl}"`);
  }
  // off by default
  expect(renderAt("?surface=board&board=list&state=populated&device=desktop").includes('data-board-filter-menu')).toBe(false);
});

test("board C4 · boundary collapses secondary controls into 筛选▾ (no row overflow)", () => {
  // Closed menu on boundary: manage-labels + Dispatch are NOT squeezed into the row.
  const closed = renderAt("?surface=board&board=list&state=boundary&device=desktop");
  expect(closed).toContain('data-board-filters');
  expect(closed.includes('data-board-manage-labels')).toBe(false); // collapsed away from the row
  expect(closed.includes("Dispatch ▾")).toBe(false);
  expect(closed).toContain("+ 新建"); // primary action stays reachable
  // more applied chips in boundary (wrap, never overflow)
  expect(closed).toContain("assignee:claude-1");
  expect(closed).toContain("epic:infra");
  // Open the boundary menu: the collapsed secondary controls live inside it.
  const open = renderAt("?surface=board&board=list&state=boundary&boardFilters=1&device=desktop");
  expect(open).toContain('data-board-filter-menu');
  expect(open).toContain('data-board-manage-labels'); // collapsed into the dropdown
  expect(open).toContain("Dispatch ▾");
});

// ── Mesh Assistant (05) ──────────────────────────────────────────────────────
test("assistant · populated: chat + tool-call card + delete confirm + composer + p2p + ⊞ full", () => {
  const out = renderAt("?surface=assistant&state=populated&device=desktop");
  expect(out).toContain('data-assistant="chat"');
  expect(out).toContain("Mesh Assistant");
  expect(out).toContain("data-assistant-tool"); // tool-call card (create_mesh)
  expect(out).toContain("create_mesh");
  expect(out).toContain("Delete"); // inline delete-confirm ApprovalCard
  expect(out).toContain('aria-label="Message composer"');
  expect(out).toContain('aria-label="attach image"'); // image advertised here
  expect(out).toContain('data-assistant-p2p'); // folded p2p DM entry
  expect(out).toContain('aria-label="全屏"'); // chat fullscreen toggle (#21)
});

test("assistant · empty shows prompt suggestions; absent(error) shows not-configured + enable, no composer", () => {
  const empty = renderAt("?surface=assistant&state=empty&device=desktop");
  expect(empty).toContain("data-assistant-suggestions");
  expect(empty).toContain("删除 scratch mesh");
  const absent = renderAt("?surface=assistant&state=error&device=desktop");
  expect(absent).toContain("未配置"); // not-configured
  expect(absent).toContain("启用助手"); // enable CTA
  expect(absent.includes('aria-label="Message composer"')).toBe(false); // no composer when absent
});

test("assistant · loading skeleton (no composer); busy shows in-flight; boundary many tool cards", () => {
  const loading = renderAt("?surface=assistant&state=loading&device=desktop");
  expect(loading).toContain("animate-pulse");
  expect(loading.includes('aria-label="Message composer"')).toBe(false);
  expect(renderAt("?surface=assistant&state=busy&device=desktop")).toContain('aria-busy="true"');
  const b = renderAt("?surface=assistant&state=boundary&device=desktop");
  expect(b).toContain("update_mesh"); // boundary-only extra tool calls
  expect(b).toContain("delete_mesh");
});

test("assistant · permission gates image attach + disables composer; offline shows reconnect", () => {
  const perm = renderAt("?surface=assistant&state=permission&device=desktop");
  expect(perm).toContain("设备未授权");
  expect(perm).toContain('aria-label="image not advertised"'); // image capability gated
  const off = renderAt("?surface=assistant&state=offline&device=desktop");
  expect(off).toContain("正在重连");
  expect(off).toContain("显示最近已知对话");
});

test("assistant · fullscreen frame (#21) + mobile has no fullscreen toggle (△ already full-width)", () => {
  const fs = renderAt("?surface=assistant&state=populated&asstFs=1&device=desktop");
  expect(fs).toContain('data-assistant-fs="1"');
  expect(fs).toContain('aria-label="退出全屏"'); // ⊟ exit
  const mob = renderAt("?surface=assistant&state=populated&device=mobile");
  expect(mob).toContain('data-device="mobile"');
  expect(mob.includes('aria-label="全屏"')).toBe(false); // toggle desktop-only
  expect(renderAt("?surface=assistant&state=populated&asstFs=1&device=mobile").includes('data-assistant-fs="1"')).toBe(false);
});

// ── Harnesses (06) ───────────────────────────────────────────────────────────
test("harnesses · populated: 4 rows + dual version + auth + self-install + old-version restarts + install done/close", () => {
  const out = renderAt("?surface=harnesses&state=populated&device=desktop");
  expect(out).toContain('data-harnesses="panel"');
  expect((out.match(/data-harness-row/g) ?? []).length).toBe(4); // claude/codex/opencode/kimi
  expect(out).toContain("claude-agent-acp 1.4.2 · claude 0.141.0"); // dual version line
  expect(out).toContain("update available — v1.2.3 → v1.2.5"); // codex outdated
  expect(out).toContain("auth required"); // codex auth badge
  expect(out).toContain('aria-label="update codex"'); // update button on outdated
  expect(out).toContain('aria-label="reprobe claude"'); // reprobe per row
  expect(out).toContain("data-self-installer"); // opencode/kimi self-install guide (#27)
  expect(out).toContain('aria-label="copy install command for opencode"');
  expect(out).toContain('aria-label="open kimi docs"');
  expect(out).toContain("data-old-agents"); // old-version restart section (#28)
  expect(out).toContain('aria-label="restart dev-mesh/codex-1 after idle"'); // after-idle
  expect(out).toContain('aria-label="force restart dev-mesh/codex-1"'); // force (two-click)
  expect(out).toContain('aria-label="cancel restart alpha/claude-1"'); // cancel pending
  expect(out).toContain("data-install-progress"); // install progress (#26)
  expect(out).toContain('aria-label="close install progress"'); // done → close
});

test("harnesses · loading shows 'loading status' + skeletons, no rows/old-agents", () => {
  const out = renderAt("?surface=harnesses&state=loading&device=desktop");
  expect(out).toContain("loading status…");
  expect(out).toContain("animate-pulse");
  expect(out.includes("data-harness-row")).toBe(false);
  expect(out.includes("data-old-agents")).toBe(false);
});

test("harnesses · error: probe ErrorBanner + interrupted install with retry stream", () => {
  const out = renderAt("?surface=harnesses&state=error&device=desktop");
  expect(out).toContain('role="alert"');
  expect(out).toContain("Probe failed");
  expect(out).toContain('aria-label="retry stream"'); // interrupted → retry (#26)
});

test("harnesses · busy: live install running spinner; boundary: many old agents + long log", () => {
  const busy = renderAt("?surface=harnesses&state=busy&device=desktop");
  expect(busy).toContain('aria-label="installing"'); // running spinner
  expect(busy.includes('aria-label="retry stream"')).toBe(false);
  const b = renderAt("?surface=harnesses&state=boundary&device=desktop");
  expect(b).toContain('aria-label="restart research/claude-3 after idle"'); // a boundary-only old agent
  expect(b).toContain("postinstall: probing tool…"); // long install log
});

test("harnesses · permission/offline disable actions + show host-side / reconnect notes", () => {
  const perm = renderAt("?surface=harnesses&state=permission&device=desktop");
  expect(perm).toContain("宿主端操作");
  expect(perm).toContain('aria-label="refresh harness status" disabled=""');
  const off = renderAt("?surface=harnesses&state=offline&device=desktop");
  expect(off).toContain("正在重连");
  expect(off).toContain('aria-label="reprobe claude" disabled=""');
});

test("harnesses · mobile: stacked panel renders", () => {
  const out = renderAt("?surface=harnesses&state=populated&device=mobile");
  expect(out).toContain('data-device="mobile"');
  expect(out).toContain('data-harnesses="panel"');
  expect(out).toContain("data-old-agents");
});

// ── Channels (07) ────────────────────────────────────────────────────────────
test("channels · populated: status + bindings + pending approve/revoke + allowSenders registry", () => {
  const out = renderAt("?surface=channels&state=populated&device=desktop");
  expect(out).toContain('data-channels="panel"');
  expect(out).toContain("data-channel-status"); // Feishu status
  expect(out).toContain("飞书 Feishu");
  expect(out).toContain("cli_a1b2c3d4"); // appId
  expect(out).toContain("data-bindings"); // chat→mesh bindings
  expect(out).toContain('aria-label="bind chat to mesh"');
  expect(out).toContain('aria-label="sync feishu groups"');
  expect(out).toContain("data-pending-senders"); // dynamic-authz inbox
  expect(out).toContain('aria-label="approve sender ou_77c…e2"');
  expect(out).toContain('aria-label="revoke pending ou_77c…e2"');
  expect(out).toContain('data-channel-enroll'); // device-auth enrollment entry overlap
  expect(out).toContain("data-authorized-senders"); // allowSenders registry
  expect(out).toContain('aria-label="revoke sender ou_me…01"');
});

test("channels · empty: not-configured hint, no bindings, pending empty, no registry", () => {
  const out = renderAt("?surface=channels&state=empty&device=desktop");
  expect(out).toContain("not configured");
  expect(out).toContain("暂无绑定");
  expect(out).toContain("暂无待审批发送者");
  expect(out.includes("data-authorized-senders")).toBe(false); // registry hidden when none/unconfigured
});

test("channels · loading skeleton (no status card); busy shows provision QR card", () => {
  const loading = renderAt("?surface=channels&state=loading&device=desktop");
  expect(loading).toContain("animate-pulse");
  expect(loading.includes("data-channel-status")).toBe(false);
  const busy = renderAt("?surface=channels&state=busy&device=desktop");
  expect(busy).toContain("data-provision"); // bind provision in flight (QR/waiting)
  expect(busy).toContain('aria-label="cancel provision"');
});

test("channels · error: config-invalid + bind/action failed banners", () => {
  const out = renderAt("?surface=channels&state=error&device=desktop");
  expect(out).toContain("config invalid");
  expect(out).toContain("Bind failed");
  expect(out).toContain('role="alert"');
});

test("channels · permission/offline disable operator actions + show banners", () => {
  const perm = renderAt("?surface=channels&state=permission&device=desktop");
  expect(perm).toContain("设备未授权");
  expect(perm).toContain('aria-label="bind chat to mesh" disabled=""');
  expect(perm).toContain('aria-label="approve sender ou_77c…e2" disabled=""');
  const off = renderAt("?surface=channels&state=offline&device=desktop");
  expect(off).toContain("正在重连");
  expect(off).toContain('aria-label="revoke sender ou_me…01" disabled=""');
});

test("channels · boundary many bindings/pending/senders", () => {
  const out = renderAt("?surface=channels&state=boundary&device=desktop");
  expect(out).toContain("security-audit"); // a boundary-only binding
  expect(out).toContain("QR78-ST90"); // a boundary-only pending authcode
  expect(out).toContain("ou_99d…4a"); // a boundary-only authorized sender
});

test("channels · mobile: read-only status + pending inbox; bindings/registry desktop-only", () => {
  const out = renderAt("?surface=channels&state=populated&device=mobile");
  expect(out).toContain('data-device="mobile"');
  expect(out).toContain("data-channel-status");
  expect(out).toContain("data-pending-senders"); // actionable inbox kept on mobile
  expect(out.includes("data-bindings")).toBe(false); // binding deferred to desktop
  expect(out.includes("data-authorized-senders")).toBe(false);
});

// ── Doctor / system (08) ─────────────────────────────────────────────────────
test("doctor · populated: summary + findings(+fixHint) + daemon table + recovery(reap/restart) + copy", () => {
  const out = renderAt("?surface=doctor&state=populated&device=desktop");
  expect(out).toContain('data-doctor="panel"');
  expect(out).toContain("data-doctor-summary");
  expect(out).toContain("worst: error");
  expect(out).toContain("agent-mesh v0.42.0"); // app/build version
  expect(out).toContain('aria-label="copy diagnostics"');
  expect(out).toContain('aria-label="run doctor"');
  expect(out).toContain("data-doctor-findings");
  expect(out).toContain("host.key"); // a check id
  expect(out).toContain("opencode not installed"); // error finding
  expect(out).toContain("self-install: npm i -g opencode"); // fixHint
  expect(out).toContain("data-daemons");
  expect(out).toContain('aria-label="restart daemon dev-mesh"'); // recovery: restart daemon
  expect(out).toContain("data-recovery");
  expect(out).toContain("data-leak");
  expect(out).toContain('aria-label="reap scratch"'); // reap a stale record
  expect(out).toContain('aria-label="reap all orphans"');
});

test("doctor · empty: daemons 'none running', no recovery panel; findings still shown", () => {
  const out = renderAt("?surface=doctor&state=empty&device=desktop");
  expect(out).toContain("none running");
  expect(out).toContain("data-doctor-findings"); // health result still present
  expect(out.includes("data-recovery")).toBe(false); // no leaks/recovery on empty
});

test("doctor · loading skeleton (no summary); busy shows reaping/run in flight", () => {
  const loading = renderAt("?surface=doctor&state=loading&device=desktop");
  expect(loading).toContain("animate-pulse");
  expect(loading.includes("data-doctor-summary")).toBe(false);
  expect(renderAt("?surface=doctor&state=busy&device=desktop")).toContain('aria-busy="true"'); // run/reap busy
});

test("doctor · permission locks the surface (device-auth gated)", () => {
  const out = renderAt("?surface=doctor&state=permission&device=desktop");
  expect(out).toContain("设备未授权");
  expect(out).toContain("诊断已锁定");
  expect(out.includes("data-doctor-findings")).toBe(false); // gated → no read
});

test("doctor · offline: service-down banner + cached version + disabled recovery", () => {
  const out = renderAt("?surface=doctor&state=offline&device=desktop");
  expect(out).toContain("服务不可达");
  expect(out).toContain("cached"); // version cached
  expect(out).toContain('aria-label="reap scratch" disabled=""');
});

test("doctor · boundary: many daemons + findings + leaks", () => {
  const out = renderAt("?surface=doctor&state=boundary&device=desktop");
  expect(out).toContain("security-audit"); // a boundary-only daemon
  expect(out).toContain("orphan.scan"); // a boundary-only finding
  expect(out).toContain("demo-3"); // a boundary-only leak
});

test("doctor · mobile: read-only summary + findings; recovery/restart deferred to desktop", () => {
  const out = renderAt("?surface=doctor&state=populated&device=mobile");
  expect(out).toContain('data-device="mobile"');
  expect(out).toContain("data-doctor-findings");
  expect(out.includes("data-recovery")).toBe(false); // recovery deferred (△)
  expect(out.includes('aria-label="restart daemon dev-mesh"')).toBe(false); // per-daemon restart still desktop-only
  // C1: copy/run doctor now sit in a compact mobile action row (summary header fits 1–2 lines)
  expect(out).toContain('aria-label="run doctor"');
  expect(out).toContain('aria-label="copy diagnostics"');
});

// ── C1 global mobile rule: actions stack onto their own row (no crammed single row) ──
test("C1 mobile · doctor summary stacks counts/actions/version; findings never two-column", () => {
  const out = renderAt("?surface=doctor&state=populated&device=mobile");
  // summary version folds to its own line (not crammed with counts)
  expect(out).toContain("agent-mesh v0.42.0");
  // findings: detail renders as its own line on mobile (no flex-1 inline column)
  expect(out).toContain("opencode not installed");
});

test("C1 mobile · harness rows put reprobe/update on their own row (nowrap buttons)", () => {
  const out = renderAt("?surface=harnesses&state=populated&device=mobile");
  expect((out.match(/whitespace-nowrap/g) ?? []).length).toBeGreaterThan(0);
  expect(out).toContain('aria-label="reprobe claude"');
  expect(out).toContain('aria-label="update codex"');
});

test("C1 mobile · channels pending header splits title / 设备授权 entry; desktop stays single-row", () => {
  const mob = renderAt("?surface=channels&state=populated&device=mobile");
  expect(mob).toContain("data-pending-senders");
  expect(mob).toContain("data-channel-enroll");
  // mobile pending card stacks (flex-col), desktop keeps the justify-between single row
  expect(mob).toContain('aria-label="approve sender ou_77c…e2"');
});

// ── Settings (09) ────────────────────────────────────────────────────────────
test("settings · populated: appearance(mode/accent/palette) + language + prefs + device mgmt", () => {
  const out = renderAt("?surface=settings&state=populated&device=desktop");
  expect(out).toContain('data-settings="panel"');
  expect(out).toContain('aria-label="theme mode"'); // mode (3)
  expect(out).toContain('aria-label="accent"'); // accent (3)
  expect(out).toContain("data-custom-palette"); // custom palette editor
  expect(out).toContain('aria-label="palette bg"');
  expect(out).toContain('aria-label="language"'); // i18n
  expect(out).toContain('aria-label="default landing view"'); // [N] pref
  expect(out).toContain('aria-label="default device"'); // [N] pref
  expect(out).toContain("data-device-row"); // device management
  expect(out).toContain('aria-label="approve device dev-3"'); // pending → approve
  expect(out).toContain('aria-label="revoke device dev-2"'); // approved → revoke
  expect(out).toContain('aria-label="mint bootstrap token"');
});

test("settings · empty: device list shows only this device", () => {
  const out = renderAt("?surface=settings&state=empty&device=desktop");
  expect(out).toContain("this device");
  expect(out.includes('aria-label="approve device dev-3"')).toBe(false); // no other devices
});

test("settings · loading skeleton (no groups)", () => {
  const out = renderAt("?surface=settings&state=loading&device=desktop");
  expect(out).toContain("animate-pulse");
  expect(out.includes("data-custom-palette")).toBe(false);
});

test("settings · error: invalid custom-palette hex tolerated (aria-invalid, no throw) + device action failed", () => {
  const out = renderAt("?surface=settings&state=error&device=desktop");
  expect(out).toContain("无效 hex"); // tolerated invalid hex note
  expect(out).toContain('aria-invalid="true"');
  expect(out).toContain("Action failed"); // device approve/revoke failed
});

test("settings · permission: approve is host-CLI authoritative (approve disabled) + note", () => {
  const out = renderAt("?surface=settings&state=permission&device=desktop");
  expect(out).toContain("由宿主 CLI 授权");
  expect(out).toContain('aria-label="approve device dev-3" disabled=""');
});

// `disabled:`-prefixed utility classes are always on the button; assert the real
// `disabled=""` *attribute* (slicing each control's window) to prove option-level disable.
const prefWindow = (out: string, label: string) => {
  const start = out.indexOf(`aria-label="${label}"`);
  const end = label === "default landing view" ? out.indexOf('aria-label="default device"') : out.indexOf("设备授权");
  return out.slice(start, end);
};
test("settings · offline: local appearance works; device mgmt + default prefs disabled + banner", () => {
  const out = renderAt("?surface=settings&state=offline&device=desktop");
  expect(out).toContain("外观/语言仍可改"); // local still works
  expect(out).toContain('aria-label="revoke device dev-2" disabled=""');
  expect(out).toContain('aria-label="theme mode"'); // appearance still present
  // default-view/device prefs are server-persisted → option buttons disabled offline (matrix △)
  expect(prefWindow(out, "default landing view")).toContain('disabled=""');
  expect(prefWindow(out, "default device")).toContain('disabled=""');
  // theme-mode option buttons stay enabled (local) — no disabled="" attribute
  const tm = out.slice(out.indexOf('aria-label="theme mode"'), out.indexOf('aria-label="accent"'));
  expect(tm.includes('disabled=""')).toBe(false);
});

test("settings · populated: default-pref options are NOT disabled (sanity vs offline)", () => {
  const out = renderAt("?surface=settings&state=populated&device=desktop");
  expect(prefWindow(out, "default landing view").includes('disabled=""')).toBe(false);
  expect(prefWindow(out, "default device").includes('disabled=""')).toBe(false);
});

test("settings · boundary: 9 mode×accent matrix + many devices", () => {
  const out = renderAt("?surface=settings&state=boundary&device=desktop");
  expect(out).toContain("data-theme-matrix"); // 3×3 preview grid
  expect((out.match(/data-device-row/g) ?? []).length).toBe(DEVICES_MANY_COUNT);
});
const DEVICES_MANY_COUNT = 8;

test("settings · mobile: stacked groups render", () => {
  const out = renderAt("?surface=settings&state=populated&device=mobile");
  expect(out).toContain('data-device="mobile"');
  expect(out).toContain('data-settings="panel"');
  expect(out).toContain('aria-label="theme mode"');
});

// ── Notifications center (10) ─────────────────────────────────────────────────
test("notifications · populated: unread badge + classes + follow actions + mark read/all + history", () => {
  const out = renderAt("?surface=notifications&state=populated&device=desktop");
  expect(out).toContain('data-notifications="center"');
  expect(out).toContain('aria-label="mark all read"');
  expect(out).toContain("data-unread-dot"); // unread indicator
  expect(out).toContain("codex-acp 有更新"); // harness-upgrade class
  expect(out).toContain("控制台前端有新版本"); // frontend self-update class
  expect(out).toContain("backend 短暂不可达后已恢复"); // connection/service class
  // follow-actions target the [E] surfaces (& HTML-escaped in href)
  expect(out).toContain("surface=harnesses");
  expect(out).toContain("surface=doctor");
  expect(out).toContain("surface=settings");
  expect(out).toContain('aria-label="刷新更新"'); // non-nav action
  expect(out).toContain('aria-label="mark read n1"'); // per-item mark read
  expect(out).toContain("历史 / 已读"); // history section
});

test("notifications · empty: all-caught-up, no badge, mark-all disabled", () => {
  const out = renderAt("?surface=notifications&state=empty&device=desktop");
  expect(out).toContain("全部已读");
  expect(out.includes("data-notif ")).toBe(false); // no items (trailing space ≠ data-notifications)
  expect(out).toContain('aria-label="mark all read" disabled=""');
});

test("notifications · loading skeleton; error load-failed+retry; busy mark-all in flight", () => {
  expect(renderAt("?surface=notifications&state=loading&device=desktop")).toContain("animate-pulse");
  const err = renderAt("?surface=notifications&state=error&device=desktop");
  expect(err).toContain("加载通知失败");
  expect(err).toContain('role="alert"');
  expect(renderAt("?surface=notifications&state=busy&device=desktop")).toContain('aria-busy="true"');
});

test("notifications · offline: connection-lost item + mark-read disabled + banner", () => {
  const out = renderAt("?surface=notifications&state=offline&device=desktop");
  expect(out).toContain("data-conn-lost"); // pinned connection-lost notice
  expect(out).toContain("显示最近已知通知"); // offline banner text
  expect(out).toContain('aria-label="mark read n1" disabled=""'); // mark-read disabled offline
  expect(out).toContain('aria-label="mark all read" disabled=""');
});

test("notifications · boundary: 99+ unread overflow + long title + many items", () => {
  const out = renderAt("?surface=notifications&state=boundary&device=desktop");
  expect(out).toContain("99+"); // unread badge overflow (count 250)
  expect(out).toContain("一条很长的系统通知标题"); // long-title boundary item
  expect(out).toContain("依赖更新可用"); // a boundary-only item
});

test("notifications · permission: read-only note + gated device-class mark-read disabled", () => {
  const out = renderAt("?surface=notifications&state=permission&device=desktop");
  expect(out).toContain("只读浏览");
  // permission surfaces the device-auth notice as unread, and its mark-read is gated (disabled)
  expect(out).toContain('aria-label="mark read n4" disabled=""');
  // a non-device unread item's mark-read stays enabled under permission (only device is gated)
  expect(out).toContain('aria-label="mark read n1"');
  expect(out.includes('aria-label="mark read n1" disabled=""')).toBe(false);
});

test("notifications · mobile: full-screen list", () => {
  const out = renderAt("?surface=notifications&state=populated&device=mobile");
  expect(out).toContain('data-device="mobile"');
  expect(out).toContain('data-notifications="center"');
  expect(out).toContain("全屏列表");
});

// ── File / artifact viewer (11) ──────────────────────────────────────────────
test("file-viewer · populated: md + code + image(→lightbox) + back + pending tray", () => {
  const out = renderAt("?surface=artifact&state=populated&device=desktop");
  expect(out).toContain('data-artifact="viewer"');
  expect(out).toContain('data-artifact-back'); // back to conversation
  expect(out).toContain("data-artifact-path"); // URL-addressable path shown
  expect(out).toContain('data-artifact-kind="markdown"');
  expect(out).toContain('data-artifact-kind="code"');
  expect(out).toContain("data-artifact-image"); // inline image → lightbox link
  expect(out).toContain('aria-label="zoom topology.png"');
  expect(out).toContain("data-pending-tray"); // composer pending-image tray
  expect(out).toContain('aria-label="attach image"');
  expect(out).toContain("data-tray-thumb");
});

test("file-viewer · loading(Bearer fetch); error 404 + back; permission 401 folds into error", () => {
  expect(renderAt("?surface=artifact&state=loading&device=desktop")).toContain("Bearer 拉取中");
  const err = renderAt("?surface=artifact&state=error&device=desktop");
  expect(err).toContain("File not found");
  expect(err).toContain('role="alert"');
  expect(err).toContain('data-artifact-back'); // back stays
  const perm = renderAt("?surface=artifact&state=permission&device=desktop");
  expect(perm).toContain("Not permitted");
  expect(perm).toContain("401");
});

test("file-viewer · empty is N/A for viewer (note) but pending tray shows its empty", () => {
  const out = renderAt("?surface=artifact&state=empty&device=desktop");
  expect(out).toContain("无空态"); // viewer N/A note
  expect(out).toContain("data-pending-tray");
  expect(out).toContain("无待发送图片"); // tray empty
  expect(out.includes("data-tray-thumb")).toBe(false);
});

test("file-viewer · lightbox overlay (?lb=1): dialog + zoom controls + close", () => {
  const out = renderAt("?surface=artifact&state=populated&lb=1&device=desktop");
  expect(out).toContain("data-artifact-lightbox");
  expect(out).toContain('aria-modal="true"');
  expect(out).toContain('aria-label="zoom in"'); // desktop zoom control
  expect(out).toContain('aria-label="close lightbox"');
  // mobile lightbox = pinch-zoom presentation (no +/- buttons)
  const mob = renderAt("?surface=artifact&state=populated&lb=1&device=mobile");
  expect(mob).toContain("data-artifact-lightbox");
  expect(mob).toContain("双指缩放");
  expect(mob.includes('aria-label="zoom in"')).toBe(false);
});

test("file-viewer · offline: alt image + cached note; tray attach disabled", () => {
  const out = renderAt("?surface=artifact&state=offline&device=desktop");
  expect(out).toContain('data-artifact-image="alt"'); // broken/alt image
  expect(out).toContain("显示最近已知内容");
  expect(out).toContain('aria-label="attach image" title="attach" disabled=""'); // tray attach disabled offline
});

test("file-viewer · pending tray states: error(upload failed+remove), busy(sending), permission(gated), boundary(many)", () => {
  const err = renderAt("?surface=artifact&state=error&device=desktop");
  expect(err).toContain("上传失败"); // tray upload-failed thumb (tray renders across states)
  const busy = renderAt("?surface=artifact&state=busy&device=desktop");
  expect(busy).toContain("发送中"); // tray sending state
  expect(busy).toContain('aria-label="sending"'); // sending spinner
  const perm = renderAt("?surface=artifact&state=permission&device=desktop");
  expect(perm).toContain("未声明图片输入"); // capability-gated attach
  const b = renderAt("?surface=artifact&state=boundary&device=desktop");
  expect(b).toContain("huge-render-4k.png (8.2 MB)"); // boundary large file in tray
});

test("file-viewer · mobile: full-screen reader + tray", () => {
  const out = renderAt("?surface=artifact&state=populated&device=mobile");
  expect(out).toContain('data-device="mobile"');
  expect(out).toContain('data-artifact="viewer"');
  expect(out).toContain("data-pending-tray");
});

// ── Device-auth gate (12) ────────────────────────────────────────────────────
test("device-auth · permission (base): device code + host-CLI approve + poll + bootstrap + deep link", () => {
  const out = renderAt("?surface=device-auth&state=permission&device=desktop");
  expect(out).toContain('data-device-auth="gate"');
  expect(out).toContain("data-device-code");
  expect(out).toContain("WXYZ-1234"); // device code
  expect(out).toContain("mesh approve"); // host-CLI approve (authoritative)
  expect(out).toContain("等待宿主批准"); // polling base state
  expect(out).toContain("data-bootstrap");
  expect(out).toContain('aria-label="bootstrap token"'); // paste field
  expect(out).toContain('aria-label="submit bootstrap token"');
  expect(out).toContain("不写入 URL、不持久化"); // body-only, never persisted
  expect(out).toContain("data-remembered");
  expect(out).toContain("/mesh/dev-mesh/agent/codex-1"); // remembered deep link
  expect(out).toContain("loopback 不受信"); // only allow path = approved device token
});

test("device-auth · loading=requesting code; error=expired+refresh; busy=submitting", () => {
  expect(renderAt("?surface=device-auth&state=loading&device=desktop")).toContain("正在请求设备码");
  const err = renderAt("?surface=device-auth&state=error&device=desktop");
  expect(err).toContain("无效或已过期"); // generic, non-leaky
  expect(err).toContain('aria-label="refresh device code"');
  expect(err).toContain('role="alert"');
  const busy = renderAt("?surface=device-auth&state=busy&device=desktop");
  expect(busy).toContain("正在解析目标"); // resolving remembered target
  expect(busy).toContain('aria-busy="true"'); // submit busy
});

test("device-auth · offline: service-unavailable (≠ not approved) + bootstrap disabled", () => {
  const out = renderAt("?surface=device-auth&state=offline&device=desktop");
  expect(out).toContain("服务不可用"); // distinct from "not approved"
  expect(out).toContain('placeholder="粘贴宿主日志里的一次性令牌…" disabled=""'); // bootstrap field disabled offline
  expect(out).toContain('aria-label="submit bootstrap token" disabled=""'); // submit disabled offline
});

test("device-auth · empty/populated render an N/A explanation (not a normal app frame)", () => {
  const e = renderAt("?surface=device-auth&state=empty&device=desktop");
  expect(e).toContain("data-device-auth-na");
  expect(e).toContain("无 empty / populated 态");
  expect(e.includes("data-device-code")).toBe(false); // no gate code on N/A
  expect(renderAt("?surface=device-auth&state=populated&device=desktop")).toContain("data-device-auth-na");
});

test("device-auth · boundary: prominent/long code + long token + long remembered route", () => {
  const out = renderAt("?surface=device-auth&state=boundary&device=desktop");
  expect(out).toContain("WXYZ-1234-ABCD-5678-EFGH-9012"); // long prominent code
  expect(out).toContain("release-candidate-2026-q3"); // long remembered route
  expect(out).toContain("break-all"); // long-code/route wrapping
});

test("device-auth · mobile: single-card full-screen gate", () => {
  const out = renderAt("?surface=device-auth&state=permission&device=mobile");
  expect(out).toContain('data-device="mobile"');
  expect(out).toContain('data-device-auth="gate"');
  expect(out).toContain("WXYZ-1234");
});

// ── Global states (13) ───────────────────────────────────────────────────────
test("global · populated=connected + the full cross-cutting contract catalog", () => {
  const out = renderAt("?surface=global&state=populated&device=desktop");
  expect(out).toContain('data-global="states"');
  expect(out).toContain("data-connected"); // normal/connected demo
  expect(out).toContain("snapshot loaded · live deltas");
  expect(out).toContain("data-global-contracts");
  // all 7 cross-cutting contracts catalogued
  expect(out).toContain("Boot / connection probe");
  expect(out).toContain("WS connect / snapshot-first");
  expect(out).toContain("Reconnect on drop");
  expect(out).toContain("Gate 401 → device-auth");
  expect(out).toContain("SPA 404 / unknown route");
  expect(out).toContain("Unified error + retry");
  expect(out).toContain("Offline contract");
});

test("global · state demos: 404/probe/boot-fail/401/retry/offline/boundary", () => {
  expect(renderAt("?surface=global&state=empty&device=desktop")).toContain("data-not-found"); // SPA 404
  expect(renderAt("?surface=global&state=empty&device=desktop")).toContain("404 · 页面不存在");
  expect(renderAt("?surface=global&state=loading&device=desktop")).toContain("正在连接控制台"); // boot probe
  const err = renderAt("?surface=global&state=error&device=desktop");
  expect(err).toContain("启动失败");
  expect(err).toContain('role="alert"');
  const perm = renderAt("?surface=global&state=permission&device=desktop");
  expect(perm).toContain("data-401-redirect");
  expect(perm).toContain("401 Unauthorized");
  expect(perm).toContain("surface=device-auth"); // routes to the gate (& escaped)
  expect(renderAt("?surface=global&state=busy&device=desktop")).toContain("重连中");
  const off = renderAt("?surface=global&state=offline&device=desktop");
  expect(off).toContain("data-reconnect");
  expect(off).toContain("正在重连");
  expect(off).toContain("最近已知");
  expect(renderAt("?surface=global&state=boundary&device=desktop")).toContain("深层坏路径");
});

test("global · contract catalog is present in every state (aggregate doc)", () => {
  for (const st of ["empty", "loading", "error", "permission", "busy", "offline", "boundary"]) {
    expect(renderAt(`?surface=global&state=${st}&device=desktop`)).toContain("data-global-contracts");
  }
});

test("global · mobile renders the states surface", () => {
  const out = renderAt("?surface=global&state=populated&device=mobile");
  expect(out).toContain('data-device="mobile"');
  expect(out).toContain('data-global="states"');
});

test("mockup uses v2 semantic utilities and emits no raw-* class", () => {
  expect(desktop).toContain("bg-surface");
  expect(desktop).toContain("text-text-primary");
  expect(/\braw-(?:slate|cool|warm|green|amber|red|blue|gray|signal-teal|ember|fleet-azure)-\d/.test(desktop)).toBe(false);
});

// ── board (03) states (Phase B) ──────────────────────────────────────────────
test("board list state · empty/loading/error stand-ins (chrome usable)", () => {
  expect(renderAt("?surface=board&board=list&state=empty")).toContain("No issues");
  expect(renderAt("?surface=board&board=list&state=loading")).toContain("animate-pulse");
  const err = renderAt("?surface=board&board=list&state=error");
  expect(err).toContain('role="alert"');
  expect(err).toContain('aria-label="meshes"');
});

test("board list state · permission read-only disables dispatch/bulk/create", () => {
  const out = renderAt("?surface=board&board=list&state=permission");
  expect(out).toContain("只读"); // board note
  expect(out).toContain("设备未授权"); // shell banner
  expect(out).toContain("disabled");
});

test("board state · busy shows CAS-409 reconcile affordance", () => {
  const out = renderAt("?surface=board&board=detail&state=busy");
  expect(out).toContain("CAS 409"); // reconcile note
  expect(out).toContain('aria-busy="true"'); // close ▾ busy spinner
});

test("board offline · last-known + edits disabled + banner", () => {
  const out = renderAt("?surface=board&board=detail&state=offline");
  expect(out).toContain("显示最近已知看板");
  expect(out).toContain("正在重连");
  expect(out).toContain("comments disabled");
});

test("board boundary · many issues incl long title + many labels + deeper epics", () => {
  const out = renderAt("?surface=board&board=list&state=boundary&device=desktop");
  expect(out).toContain("Epic: Infrastructure"); // MANY_EPICS-only epic
  expect(out).toContain("truncate gracefully without breaking"); // long title
  expect(out).toContain("#26"); // a MANY_ISSUES-only issue
});

test("board DETAIL boundary · long body + many subtasks + multiple deps + longer timeline (≠ populated)", () => {
  const det = renderAt("?surface=board&board=detail&state=boundary&device=desktop");
  expect(det).toContain("deliberately long markdown body"); // boundary-only body
  expect(det).toContain("#23 (in_review)"); // multiple deps (boundary-only)
  expect(det).toContain("virtualize list"); // a boundary-only subtask line
  expect(det).toContain("split into 9 subtasks"); // boundary-only timeline entry
  // populated detail must NOT carry the boundary body
  expect(renderAt("?surface=board&board=detail&state=populated").includes("deliberately long markdown body")).toBe(false);
  // mobile detail boundary also shows boundary body
  expect(renderAt("?surface=board&board=detail&state=boundary&device=mobile")).toContain("deliberately long markdown body");
});

test("board mobile · list + detail states usable; kanban degrades to list", () => {
  expect(renderAt("?surface=board&board=list&state=populated&device=mobile")).toContain('data-board="list"');
  expect(renderAt("?surface=board&board=detail&state=populated&device=mobile")).toContain("Activity");
  expect(renderAt("?surface=board&board=kanban&state=populated&device=mobile")).toContain('data-board="list"');
});

// ── new-mesh builder (04) states (Phase B) ───────────────────────────────────
test("new-mesh · builder frame: name/agents/edges/charter + Save/Cancel", () => {
  const out = renderAt("?surface=new-mesh&state=populated&device=desktop");
  expect(out).toContain('data-newmesh="builder"');
  expect(out).toContain("New mesh");
  expect(out).toContain('aria-label="mesh name"');
  expect(out).toContain('aria-label="agent 1 id"');
  expect(out).toContain("+ Add agent");
  expect(out).toContain("+ Add edge");
  expect(out).toContain('aria-label="charter"');
  expect(out).toContain("Save");
  expect(out).toContain("Cancel");
});

test("new-mesh · empty: blank form, one router row, no edges", () => {
  const out = renderAt("?surface=new-mesh&state=empty&device=desktop");
  expect(out).toContain("no edges yet");
  expect(out).toContain("agents · 1");
  expect(out).toContain("disabled"); // Save disabled when invalid
});

test("new-mesh · error: dup-name + missing-id validation + ErrorBanner", () => {
  const out = renderAt("?surface=new-mesh&state=error&device=desktop");
  expect(out).toContain('role="alert"');
  expect(out).toContain("already exists"); // dup name field error
  expect(out).toContain('aria-invalid="true"'); // error fields
});

test("new-mesh · permission: unauthorized banner + form disabled", () => {
  const out = renderAt("?surface=new-mesh&state=permission&device=desktop");
  expect(out).toContain("设备未授权");
  expect(out).toContain("disabled");
});

test("new-mesh · busy: Save shows busy spinner", () => {
  expect(renderAt("?surface=new-mesh&state=busy&device=desktop")).toContain('aria-busy="true"');
});

test("new-mesh · offline: reconnecting banner + fields/Save disabled (Cancel stays)", () => {
  const out = renderAt("?surface=new-mesh&state=offline&device=desktop");
  expect(out).toContain("正在重连"); // offline banner
  expect(out).toContain("disabled"); // mutating fields/Save disabled
  expect(out).toContain("Cancel"); // local nav stays
  // mobile offline too
  expect(renderAt("?surface=new-mesh&state=offline&device=mobile")).toContain("正在重连");
});

test("new-mesh · boundary: many agents + many edges + long name/id", () => {
  const out = renderAt("?surface=new-mesh&state=boundary&device=desktop");
  expect(out).toContain("a-very-long-agent-identifier-for-truncation");
  expect(out).toContain("agents · 12"); // C3: 12-agent long-form target
  expect(out).toContain("release-candidate-2026-q3-extended-pipeline");
  expect(out).toContain('aria-label="agent 12 id"'); // 12th row present/reachable
});

// ── C3: new-mesh long-form scrolling (sticky action bar / fixed Save / add-flow) ──
test("new-mesh C3 · desktop: sticky action bar holds Cancel/Save; no mobile footer", () => {
  const out = renderAt("?surface=new-mesh&state=boundary&device=desktop");
  expect(out).toContain('data-newmesh-actionbar="sticky"');
  expect(out).toContain("sticky top-0"); // pinned while the long form scrolls
  expect(out).not.toContain('data-newmesh-actionbar="footer"'); // desktop keeps actions in the bar
  // name echoed in the reachable action bar
  expect(out).toContain("release-candidate-2026-q3-extended-pipeline");
});

test("new-mesh C3 · mobile: Save fixed at the bottom footer; whole body scrolls", () => {
  const out = renderAt("?surface=new-mesh&state=populated&device=mobile");
  expect(out).toContain('data-newmesh-actionbar="footer"'); // Save fixed at bottom
  expect(out).toContain("flex-1 overflow-auto"); // body scrolls above the footer
  // footer carries the Save action
  const footerIdx = out.indexOf('data-newmesh-actionbar="footer"');
  expect(out.slice(footerIdx)).toContain("Save");
});

test("new-mesh C3 · add-agent flow: + Add agent marked; newest row scrolls-in + focuses id", () => {
  const out = renderAt("?surface=new-mesh&state=boundary&device=desktop");
  expect(out).toContain("data-newmesh-addflow"); // + Add agent affordance
  expect(out).toContain('data-newmesh-newest="true"'); // the just-added row highlighted
  expect(out).toContain("已滚动入视并聚焦"); // add-flow caption
  // newest marker + focus visual live on the LAST (12th) agent row
  const newestIdx = out.indexOf('data-newmesh-newest="true"');
  expect(out.slice(newestIdx)).toContain('aria-label="agent 12 id"');
});

test("new-mesh C3 · add-flow highlight only in boundary (not in plain populated)", () => {
  expect(renderAt("?surface=new-mesh&state=populated&device=desktop")).not.toContain('data-newmesh-newest="true"');
});

test("new-mesh · mobile: simplified builder (from/to edge pickers)", () => {
  const out = renderAt("?surface=new-mesh&state=populated&device=mobile");
  expect(out).toContain('data-device="mobile"');
  expect(out).toContain('data-newmesh="builder"');
  expect(out).toContain("from / to pickers");
});

test("new-mesh · per-agent controls: instructions + model/effort/lazy + opencode permission + edge steer + auto-compact", () => {
  const out = renderAt("?surface=new-mesh&state=populated&device=desktop");
  expect(out).toContain('aria-label="agent 1 instructions"'); // per-agent instructions (audit #1)
  expect(out).toContain('aria-label="agent 1 model"'); // model (audit #3)
  expect(out).toContain('aria-label="agent 1 effort"'); // effort (audit #4)
  expect(out).toContain('aria-label="agent 1 lazy"'); // lazy (audit #5)
  expect(out).toContain('aria-label="agent 3 opencode permission"'); // opencode-only (audit #6) — reviewer is opencode
  expect(out).toContain('aria-label="auto-compact enabled"'); // auto-compact (audit #7)
  expect(out).toContain('aria-label="auto-compact threshold"');
  expect(out).toContain('aria-label="edge 1 steer"'); // edge steer (audit #8)
});

test("new-mesh · expanded text editor: charter (desktop modal) + instructions (mobile sheet)", () => {
  const charter = renderAt("?surface=new-mesh&state=populated&nmEditor=charter&device=desktop");
  expect(charter).toContain('role="dialog"');
  expect(charter).toContain('aria-modal="true"');
  expect(charter).toContain('data-newmesh-editor="charter"');
  expect(charter).toContain("/ 4000"); // char count
  const instr = renderAt("?surface=new-mesh&state=populated&nmEditor=instructions&device=mobile");
  expect(instr).toContain('data-newmesh-editor="instructions"');
  expect(instr).toContain('aria-modal="true"');
  expect(renderAt("?surface=new-mesh&state=populated").includes("data-newmesh-editor=")).toBe(false); // off by default
});

test("new-mesh · offline still disables the new per-agent controls", () => {
  const out = renderAt("?surface=new-mesh&state=offline&device=desktop");
  expect(out).toContain("正在重连");
  expect(out).toContain("disabled");
});
