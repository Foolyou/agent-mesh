import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PanelFrame, SegmentedControl, nextSegmentValue, StatusListRow, EmptyState, ErrorBanner, ActionBar, Cluster, Spacer, RouteLink, Button,
} from "./index";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

// ── PanelFrame ─────────────────────────────────────────────────────────────────
test("PanelFrame: labelled section + header/actions/footer on a raised surface", () => {
  const out = html(
    <PanelFrame title="Meshes" description="3 active" actions={<Button>New</Button>} footer="updated just now">
      body
    </PanelFrame>,
  );
  expect(out).toContain("<section");
  expect(out).toContain("bg-surface-raised");
  expect(out).toContain("<h2");
  expect(out).toContain("Meshes");
  expect(out).toContain("3 active");
  expect(out).toContain("body");
  expect(out).toContain("<footer");
  // section aria-labelledby points at the heading id
  const labelledby = /aria-labelledby="([^"]+)"/.exec(out)?.[1];
  expect(labelledby).toBeTruthy();
  expect(out).toContain(`id="${labelledby}"`);
});

test("PanelFrame: no header markup when title/description/actions all absent", () => {
  const out = html(<PanelFrame>only body</PanelFrame>);
  expect(out).not.toContain("<header");
  expect(out).not.toContain("aria-labelledby");
  expect(out).toContain("only body");
});

// ── SegmentedControl ───────────────────────────────────────────────────────────
test("SegmentedControl: radiogroup with aria-checked on the selected option", () => {
  const out = html(
    <SegmentedControl
      ariaLabel="View"
      value="board"
      onChange={() => {}}
      options={[
        { value: "list", label: "List" },
        { value: "board", label: "Board" },
        { value: "detail", label: "Detail", disabled: true },
      ]}
    />,
  );
  expect(out).toContain('role="radiogroup"');
  expect(out).toContain('aria-label="View"');
  expect((out.match(/role="radio"/g) ?? []).length).toBe(3);
  expect(out).toContain('aria-checked="true"'); // the selected one
  expect(out).toContain('aria-checked="false"');
  expect(out).toContain("disabled"); // the detail option
  // selected segment gets the raised pill treatment
  expect(out).toContain("bg-surface-raised");
});

test("SegmentedControl: roving tabindex — selected enabled is 0, others -1, disabled has none", () => {
  const out = html(
    <SegmentedControl
      ariaLabel="View"
      value="board"
      onChange={() => {}}
      options={[
        { value: "list", label: "List" },
        { value: "board", label: "Board" },
        { value: "detail", label: "Detail", disabled: true },
      ]}
    />,
  );
  expect((out.match(/tabindex="0"/g) ?? []).length).toBe(1); // only the selected enabled option
  expect((out.match(/tabindex="-1"/g) ?? []).length).toBe(1); // the other enabled option
  // the disabled option carries `disabled`, not a tabindex
  expect(out).toContain("disabled");
});

test("nextSegmentValue: arrows/Home/End wrap and skip disabled options", () => {
  const opts = [
    { value: "a", label: "A" },
    { value: "b", label: "B", disabled: true },
    { value: "c", label: "C" },
    { value: "d", label: "D" },
  ];
  // ArrowRight from a skips disabled b → c; wraps d → a
  expect(nextSegmentValue(opts, "a", "ArrowRight")).toBe("c");
  expect(nextSegmentValue(opts, "d", "ArrowRight")).toBe("a");
  expect(nextSegmentValue(opts, "c", "ArrowDown")).toBe("d"); // Down == Right
  // ArrowLeft from c skips disabled b → a; wraps a → d
  expect(nextSegmentValue(opts, "c", "ArrowLeft")).toBe("a");
  expect(nextSegmentValue(opts, "a", "ArrowUp")).toBe("d"); // Up == Left
  // Home/End land on first/last ENABLED option
  expect(nextSegmentValue(opts, "c", "Home")).toBe("a");
  expect(nextSegmentValue(opts, "a", "End")).toBe("d");
  // non-navigation keys → null (no interception)
  expect(nextSegmentValue(opts, "a", "Enter")).toBeNull();
  expect(nextSegmentValue(opts, "a", " ")).toBeNull();
});

// ── StatusListRow ──────────────────────────────────────────────────────────────
test("StatusListRow: href → real <a> with a status dot + title + trailing", () => {
  const out = html(<StatusListRow status="working" title="alpha" meta="2m ago" trailing={<span>9</span>} href="/mesh/alpha" />);
  expect(out).toContain("<a");
  expect(out).toContain('href="/mesh/alpha"');
  expect(out).toContain('role="img"'); // StatusChip dot
  expect(out).toContain('aria-label="working"');
  expect(out).toContain("alpha");
  expect(out).toContain("2m ago");
  expect(out).toContain("9");
  expect(out).not.toContain("text-link"); // unstyled row wrapper, not a default link
});

test("StatusListRow: onClick → <button>; active → selected tokens + aria-current", () => {
  const btn = html(<StatusListRow status="ready" title="beta" onClick={() => {}} />);
  expect(btn).toContain("<button");
  const active = html(<StatusListRow status="blocked" title="gamma" href="/x" active />);
  expect(active).toContain("bg-selected");
  expect(active).toContain("text-text-on-selected");
  expect(active).toContain('aria-current="page"');
  // non-interactive falls back to a div
  expect(html(<StatusListRow status="idle" title="delta" />)).toContain("<div");
});

// ── EmptyState ─────────────────────────────────────────────────────────────────
test("EmptyState: title/description/action; icon is decorative", () => {
  const out = html(<EmptyState icon={<svg />} title="No meshes yet" description="Create one to begin." action={<Button>Create</Button>} />);
  expect(out).toContain("No meshes yet");
  expect(out).toContain("Create one to begin.");
  expect(out).toContain("Create");
  expect(out).toContain('aria-hidden="true"'); // icon wrapper
  expect(out).toContain("text-text-primary");
});

// ── ErrorBanner ────────────────────────────────────────────────────────────────
test("ErrorBanner: role=alert, danger soft surface, retry + dismiss", () => {
  const out = html(<ErrorBanner title="Load failed" onRetry={() => {}} onDismiss={() => {}}>connection lost</ErrorBanner>);
  expect(out).toContain('role="alert"');
  expect(out).toContain("bg-danger-subtle");
  expect(out).toContain("border-danger");
  expect(out).toContain("Load failed");
  expect(out).toContain("connection lost");
  expect(out).toContain("Retry");
  expect(out).toContain('aria-label="Dismiss"');
});

// ── ActionBar / layout atoms ─────────────────────────────────────────────────────
test("ActionBar: role=toolbar; end cluster splits the row", () => {
  const out = html(
    <ActionBar ariaLabel="Mesh actions" end={<Button>Stop</Button>}>
      <Cluster><Button>Start</Button></Cluster>
      <Spacer />
    </ActionBar>,
  );
  expect(out).toContain('role="toolbar"');
  expect(out).toContain('aria-label="Mesh actions"');
  expect(out).toContain("justify-between");
  expect(out).toContain("Start");
  expect(out).toContain("Stop");
});

// ── RouteLink unstyled (C6 addition) ─────────────────────────────────────────────
test("RouteLink unstyled drops link visuals but keeps the focus ring", () => {
  const out = html(<RouteLink href="/x" unstyled>x</RouteLink>);
  expect(out).not.toContain("text-link");
  expect(out).not.toContain("hover:underline");
  expect(out).toContain("outline-focus-ring");
});

// ── token discipline ───────────────────────────────────────────────────────────
test("no rendered C6 surface emits a raw-* utility class", () => {
  const all = [
    html(<PanelFrame title="t" actions={<Button>a</Button>} footer="f">b</PanelFrame>),
    html(<SegmentedControl ariaLabel="v" value="a" onChange={() => {}} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />),
    html(<StatusListRow status="working" title="x" href="/x" active />),
    html(<EmptyState icon={<svg />} title="t" description="d" action={<Button>c</Button>} />),
    html(<ErrorBanner title="e" onRetry={() => {}} onDismiss={() => {}}>m</ErrorBanner>),
    html(<ActionBar ariaLabel="a" end={<Button>z</Button>}><Button>y</Button></ActionBar>),
  ].join(" ");
  expect(/\braw-(?:slate|cool|warm|green|amber|red|blue|gray|signal-teal|ember|fleet-azure)-\d/.test(all)).toBe(false);
});
