// Step 7.3 — focused SSR tests for the /bnw new/edit-mesh builder (create mode + expanded
// editor). Renders against a stub store (no real fetch). Asserts the parity #1–#8 controls,
// the C3 sticky action bar + mobile fixed Save footer, and the focus-trap editor dialog.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BnwNewMesh } from "./new-mesh";
import type { GatewayState } from "../../types";
import type { Store } from "../store";

const STATE: GatewayState = { meshes: [], assistant: { status: "absent", transcript: [] }, perMesh: {} };
const STUB = { listHarnesses: async () => [], defineMesh: async () => ({}) } as unknown as Store;

test("new-mesh create: name + agent row (#1–#8 controls) + C3 sticky bar/footer + Save", () => {
  const out = renderToStaticMarkup(<BnwNewMesh store={STUB} state={STATE} route={{}} />);
  expect(out).toContain("data-bnw-newmesh");
  expect(out).toContain('aria-label="mesh name"');
  expect(out).toContain('aria-label="agent 1 id"');
  expect(out).toContain('aria-label="agent 1 harness"');
  expect(out).toContain('aria-label="agent 1 role"');
  expect(out).toContain('aria-label="agent 1 project"');
  expect(out).toContain('aria-label="agent 1 model"');        // #3
  expect(out).toContain('aria-label="agent 1 lazy"');         // #5
  expect(out).toContain('aria-label="agent 1 instructions"'); // #1
  expect(out).toContain('aria-label="expand agent 1 instructions"'); // #2 trigger
  expect(out).toContain('aria-label="auto-compact enabled"'); // #7
  expect(out).toContain('aria-label="auto-compact threshold"');
  expect(out).toContain('aria-label="add agent"');
  expect(out).toContain('aria-label="add edge"');
  expect(out).toContain('aria-label="charter"');
  expect(out).toContain('aria-label="save mesh"');
  // C3 — sticky desktop action bar + mobile fixed Save footer
  expect(out).toContain("data-bnw-newmesh-actionbar");
  expect(out).toContain("sticky top-0");
  expect(out).toContain("data-bnw-newmesh-footer");
});

test("new-mesh ?nmEditor=charter opens the focus-trap editor dialog (#2)", () => {
  const out = renderToStaticMarkup(<BnwNewMesh store={STUB} state={STATE} route={{ nmEditor: "charter" }} />);
  expect(out).toContain("data-bnw-editor");
  expect(out).toContain('role="dialog"');
  expect(out).toContain('aria-modal="true"');
  expect(out).toContain("/ 4000"); // char count
  expect(out).toContain('aria-label="apply editor"');
});

test("new-mesh: router row cannot be removed or marked lazy", () => {
  const out = renderToStaticMarkup(<BnwNewMesh store={STUB} state={STATE} route={{}} />);
  // the first row defaults to router → its remove + lazy controls are disabled
  expect(out).toMatch(/aria-label="remove agent 1"[^>]*disabled/);
  expect(out).toMatch(/aria-label="agent 1 lazy"[^>]*disabled/);
});

test("new-mesh editor not open by default", () => {
  expect(renderToStaticMarkup(<BnwNewMesh store={STUB} state={STATE} route={{}} />).includes("data-bnw-editor")).toBe(false);
});
