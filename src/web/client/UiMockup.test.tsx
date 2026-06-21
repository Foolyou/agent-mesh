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

test("runtime A · mobile focus: approval pinned above transcript + composer", () => {
  const out = renderAt("?device=mobile&surface=runtime&runtime=focus");
  expect(out).toContain('data-runtime="focus"');
  expect(out).toContain("Allow"); // ApprovalCard above transcript
  expect(out).toContain("Transcript");
  expect(out).toContain('aria-label="Message composer"');
  // approval markup appears before the transcript panel
  expect(out.indexOf("Allow")).toBeLessThan(out.indexOf("Transcript"));
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

test("runtime mobile · list pins approvals; focus pins approval above transcript", () => {
  const list = renderAt("?surface=runtime&runtime=overview&state=populated&device=mobile");
  expect(list).toContain('data-device="mobile"');
  expect(list).toContain("待审批");
  const focus = renderAt("?surface=runtime&runtime=focus&state=populated&device=mobile");
  expect(focus).toContain("Transcript");
  expect(focus.indexOf("Allow")).toBeLessThan(focus.indexOf("Transcript"));
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
  expect(out).toContain("surface=assistant"); // assistant deep links
  expect(out).toContain("surface=harnesses"); // harnesses deep links
  expect(out).toContain("surface=channels"); // channels deep links
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
  const out = renderAt("?surface=board&board=list&state=populated&device=desktop");
  expect(out).toContain('aria-label="group by epic"'); // group-by-epic (#23)
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
  const perm = renderAt("?surface=board&board=list&state=permission&boardManage=1&device=desktop");
  expect(perm).toContain('disabled="" aria-label="new label name"'); // create-label input disabled
  expect(perm).toContain('disabled="" aria-label="group by epic"'); // checkbox disabled
  expect(renderAt("?surface=board&board=list&state=offline&device=desktop")).toContain('disabled="" aria-label="new epic"');
});

test("board补漏 mobile · group-by-epic in the filter row (fullscreen/manager are desktop-only)", () => {
  const out = renderAt("?surface=board&board=list&state=populated&device=mobile");
  expect(out).toContain('aria-label="group by epic"');
  // fullscreen flag is ignored on mobile (no standalone frame)
  expect(renderAt("?surface=board&board=list&state=populated&boardFs=1&device=mobile").includes('data-board-fs="1"')).toBe(false);
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
  expect(out).toContain("agents · 10");
  expect(out).toContain("release-candidate-2026-q3-extended-pipeline");
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
