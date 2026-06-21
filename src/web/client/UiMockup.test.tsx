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

test("mockup uses v2 semantic utilities and emits no raw-* class", () => {
  expect(desktop).toContain("bg-surface");
  expect(desktop).toContain("text-text-primary");
  expect(/\braw-(?:slate|cool|warm|green|amber|red|blue|gray|signal-teal|ember|fleet-azure)-\d/.test(desktop)).toBe(false);
});
