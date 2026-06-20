// Step 6 — the application-shell mockup renders from the REAL ui/ components with
// fixture data. SSR assertions (useEffect/applyComposition don't run under
// renderToStaticMarkup; readSel() guards on `typeof window`). Browser behavior
// (view switch, device deep link, screenshots) lives in src/web/ui-mockup.e2e.ts.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UiMockup } from "./UiMockup";

const desktop = renderToStaticMarkup(<UiMockup />);

test("desktop shell: topbar (mesh selector + view switcher + 管理/设置/通知), left nav, stage", () => {
  expect(desktop).toContain('data-mockup="root"');
  expect(desktop).toContain('data-device="desktop"');
  expect(desktop).toContain('aria-label="active mesh"'); // mesh selector
  expect(desktop).toContain('role="radiogroup"'); // SegmentedControl view switcher
  expect(desktop).toContain("运行态");
  expect(desktop).toContain("看板");
  expect(desktop).toContain("管理▾");
  expect(desktop).toContain("设置▾");
  expect(desktop).toContain("+ New mesh");
  expect(desktop).toContain('aria-label="meshes"'); // left nav
  expect(desktop).toContain('aria-label="context"'); // right context
  expect(desktop).toContain("dev-mesh"); // fixture mesh
  expect(desktop).toContain("视图占位"); // stage placeholder
});

test("mobile shell: slim topbar + bottom tabs 运行态·看板·更多", () => {
  const g = globalThis as any;
  const prev = g.window;
  g.window = { location: { search: "?device=mobile" } };
  try {
    const mobile = renderToStaticMarkup(<UiMockup />);
    expect(mobile).toContain('data-device="mobile"');
    expect(mobile).toContain('role="tablist"');
    expect((mobile.match(/role="tab"/g) ?? []).length).toBe(3);
    expect(mobile).toContain("更多");
    expect(mobile).toContain('aria-label="active mesh"'); // selector kept in slim topbar
  } finally {
    g.window = prev;
  }
});

test("mockup uses v2 semantic utilities and emits no raw-* class", () => {
  expect(desktop).toContain("bg-surface");
  expect(desktop).toContain("text-text-primary");
  expect(/\braw-(?:slate|cool|warm|green|amber|red|blue|gray|signal-teal|ember|fleet-azure)-\d/.test(desktop)).toBe(false);
});
