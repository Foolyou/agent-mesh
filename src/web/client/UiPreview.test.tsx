// Step 5 C8 — the gallery renders the REAL C5–C7 components (not sample markup).
// SSR render assertions: useEffect (applyComposition) does not run under
// renderToStaticMarkup, and readSelection() guards on `typeof window`, so this
// needs no DOM. Browser behavior (9-state switch, deep links, screenshots) is in
// src/web/ui-gallery.e2e.ts.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UiPreview } from "./UiPreview";

const out = renderToStaticMarkup(<UiPreview />);

test("gallery header + live-instance note render", () => {
  expect(out).toContain("Agent Mesh — UI gallery");
  expect(out).toContain("MESH_UI_PREVIEW=1");
  expect(out).toContain('data-gallery="root"');
});

test("every component section is present", () => {
  for (const id of [
    "buttons", "statuschip", "badge", "links", "forms", "feedback",
    "panelframe", "segmented", "listrows", "emptystate", "errorbanner", "actionbar",
    "approval", "composer", "attachment", "version", "assignee",
  ]) {
    expect(out).toContain(`data-section="${id}"`);
  }
});

test("sections use the real ui components (representative a11y roles + tokens)", () => {
  expect(out).toContain('role="radiogroup"'); // SegmentedControl (mode/accent + demo)
  expect(out).toContain('role="alert"'); // ErrorBanner
  expect(out).toContain('role="toolbar"'); // ActionBar
  expect(out).toContain('role="progressbar"'); // ProgressBar
  expect(out).toContain('role="group"'); // ApprovalCard / Composer
  expect(out).toContain("Allow writing"); // ApprovalCard question
  expect(out).toContain("AL"); // AssigneeTag initials for "Ada Lovelace"
  expect(out).toContain("99+"); // Badge overflow
  expect(out).toContain("·"); // VersionLine separator
  expect(out).toContain("bg-accent"); // v2 semantic utilities in use
});

test("gallery emits no raw-* utility class", () => {
  expect(/\braw-(?:slate|cool|warm|green|amber|red|blue|gray|signal-teal|ember|fleet-azure)-\d/.test(out)).toBe(false);
});
