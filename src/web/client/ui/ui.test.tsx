import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, ConfirmButton, StatusChip, Badge, RouteLink, spaTarget, Input, Textarea, Select, Spinner, Skeleton, ProgressBar, type RouteClick } from "./index";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

// ── Button ───────────────────────────────────────────────────────────────────
test("Button variants/sizes map to v2 semantic utilities", () => {
  const primary = html(<Button variant="primary">Go</Button>);
  expect(primary).toContain("<button");
  expect(primary).toContain("bg-accent");
  expect(primary).toContain("text-on-accent");
  expect(html(<Button variant="secondary">x</Button>)).toContain("border-border-strong");
  expect(html(<Button variant="danger">x</Button>)).toContain("bg-danger");
  expect(html(<Button variant="danger">x</Button>)).toContain("text-on-danger");
  expect(html(<Button size="sm">x</Button>)).toContain("text-xs");
});

test("Button disabled + busy states (a11y: disabled attr, aria-busy, spinner)", () => {
  expect(html(<Button disabled>x</Button>)).toContain("disabled");
  const busy = html(<Button busy>x</Button>);
  expect(busy).toContain('aria-busy="true"');
  expect(busy).toContain('role="status"'); // spinner
  expect(busy).toContain("disabled"); // busy implies disabled
});

// Filled variants must drop their accent/danger fill when disabled so dimmed
// text-disabled clears the 3:1 DISABLED_FLOOR (regression: disabled primary kept bg-accent).
test("Button disabled-primary/danger: enabled fill is accent/danger, disabled fill is neutral", () => {
  const primary = html(<Button variant="primary">Save</Button>);
  // enabled fill matches the approved mockup (accent), unconditionally
  expect(primary).toContain("bg-accent");
  expect(primary).not.toContain("disabled:bg-accent");
  // disabled state overrides to the neutral surface-raised treatment (wins by :disabled specificity)
  expect(primary).toContain("disabled:bg-surface-raised");
  expect(primary).toContain("disabled:border-border-strong");
  expect(primary).toContain("disabled:text-text-disabled");
  const danger = html(<Button variant="danger">Delete</Button>);
  expect(danger).toContain("bg-danger");
  expect(danger).not.toContain("disabled:bg-danger");
  expect(danger).toContain("disabled:bg-surface-raised");
  // ghost/link/secondary keep their (already-neutral) styling — no accent fill to strip
  expect(html(<Button variant="ghost">x</Button>)).not.toContain("disabled:bg-surface-raised");
  expect(html(<Button variant="secondary">x</Button>)).not.toContain("disabled:bg-surface-raised");
});

test("ConfirmButton renders an armable danger button with its base label", () => {
  const out = html(<ConfirmButton onConfirm={() => {}}>Delete mesh</ConfirmButton>);
  expect(out).toContain("<button");
  expect(out).toContain("Delete mesh"); // idle shows base label, not the confirm label
  expect(out).not.toContain("Confirm?");
  expect(out).toContain("bg-danger");
});

test("ConfirmButton honors variant (primary → bg-accent, not bg-danger)", () => {
  const out = html(<ConfirmButton variant="primary" onConfirm={() => {}}>Save</ConfirmButton>);
  expect(out).toContain("bg-accent");
  expect(out).not.toContain("bg-danger");
});

// ── StatusChip ────────────────────────────────────────────────────────────────
test("StatusChip worded/soft/filled/dot variants use the right tone tokens", () => {
  const ready = html(<StatusChip status="ready" />);
  expect(ready).toContain("text-success");
  expect(ready).toContain("ready");
  expect(html(<StatusChip status="blocked" variant="soft" />)).toContain("bg-danger-subtle");
  const filled = html(<StatusChip status="attention" variant="filled" />);
  expect(filled).toContain("bg-warning");
  expect(filled).toContain("text-on-warning");
  const dot = html(<StatusChip status="working" variant="dot" />);
  expect(dot).toContain('role="img"');
  expect(dot).toContain('aria-label="working"');
  expect(dot).toContain("bg-accent");
  expect(html(<StatusChip status="ready" count={3} />)).toContain("3");
});

// ── Badge ─────────────────────────────────────────────────────────────────────
test("Badge tones + overflow + dot", () => {
  const urgent = html(<Badge count={5} tone="urgent" />);
  expect(urgent).toContain("bg-danger");
  expect(urgent).toContain("text-on-danger");
  expect(urgent).toContain("5");
  expect(html(<Badge count={250} max={99} />)).toContain("99+");
  expect(html(<Badge dot tone="accent" label="unread" />)).toContain('role="status"');
});

// ── RouteLink ──────────────────────────────────────────────────────────────────
test("RouteLink is a real <a href>, marks active with aria-current", () => {
  const link = html(<RouteLink href="/mesh/alpha">alpha</RouteLink>);
  expect(link).toContain("<a");
  expect(link).toContain('href="/mesh/alpha"');
  expect(link).toContain("text-link");
  expect(html(<RouteLink href="/x" active>x</RouteLink>)).toContain('aria-current="page"');
  expect(html(<RouteLink href="/x">x</RouteLink>)).not.toContain("aria-current");
});

test("spaTarget: same-origin plain left-click is intercepted, everything else is native", () => {
  const ORIGIN = "https://app.example.com";
  const plain: RouteClick = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  // same-origin relative + absolute → intercept, returns pathname+search+hash
  expect(spaTarget("/mesh/alpha?tab=1#x", plain, ORIGIN)).toBe("/mesh/alpha?tab=1#x");
  expect(spaTarget(`${ORIGIN}/board`, plain, ORIGIN)).toBe("/board");
  // cross-origin → native (null), never pushState (which would throw on a cross-origin URL)
  expect(spaTarget("https://example.com/", plain, ORIGIN)).toBeNull();
  // download → native
  expect(spaTarget("/file.zip", plain, ORIGIN, undefined, "report.zip")).toBeNull();
  expect(spaTarget("/file.zip", plain, ORIGIN, undefined, true)).toBeNull();
  // target=_blank / modified / non-left / already-prevented → native
  expect(spaTarget("/x", plain, ORIGIN, "_blank")).toBeNull();
  expect(spaTarget("/x", { ...plain, metaKey: true }, ORIGIN)).toBeNull();
  expect(spaTarget("/x", { ...plain, button: 1 }, ORIGIN)).toBeNull();
  expect(spaTarget("/x", { ...plain, defaultPrevented: true }, ORIGIN)).toBeNull();
});

// ── form controls ──────────────────────────────────────────────────────────────
test("Input/Textarea/Select default vs error (a11y: aria-invalid + danger edge)", () => {
  expect(html(<Input placeholder="name" />)).toContain("border-border-strong");
  const errIn = html(<Input error />);
  expect(errIn).toContain('aria-invalid="true"');
  expect(errIn).toContain("border-danger");
  expect(html(<Textarea error />)).toContain('aria-invalid="true"');
  expect(html(<Select error><option>a</option></Select>)).toContain("border-danger");
  expect(html(<Select><option>a</option></Select>)).toContain("border-border-strong");
});

// ── feedback ───────────────────────────────────────────────────────────────────
test("feedback primitives expose correct a11y roles", () => {
  expect(html(<Spinner />)).toContain('role="status"');
  expect(html(<Spinner />)).toContain("border-t-accent");
  expect(html(<Skeleton variant="card" />)).toContain('aria-hidden="true"');
  const pb = html(<ProgressBar value={42} />);
  expect(pb).toContain('role="progressbar"');
  expect(pb).toContain('aria-valuenow="42"');
  expect(pb).toContain('aria-valuemax="100"');
  expect(pb).toContain("bg-accent");
});

// ── token discipline ───────────────────────────────────────────────────────────
test("no rendered primitive emits a raw-* utility class", () => {
  const all = [
    html(<Button variant="primary">x</Button>),
    html(<StatusChip status="attention" variant="filled" />),
    html(<Badge count={1} tone="urgent" />),
    html(<RouteLink href="/x">x</RouteLink>),
    html(<Input error />),
    html(<ProgressBar value={1} />),
  ].join(" ");
  expect(/\braw-(?:slate|cool|warm|green|amber|red|blue|gray|signal-teal|ember|fleet-azure)-\d/.test(all)).toBe(false);
});
