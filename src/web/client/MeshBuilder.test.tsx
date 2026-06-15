import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeshBuilder, nextTabIndexForKey, validateAutoCompactSettingsInput, validateAutoCompactThresholdInput } from "./MeshBuilder";
import type { Store } from "./store";
import type { MeshConfig } from "../types";

const baseConfig: MeshConfig = {
  name: "demo",
  agents: [{ id: "router", harness: "claude", role: "router", project: "test_mesh_0" }],
  edges: [],
};

const store = {
  defineMesh: async () => {},
} as unknown as Store;

function render(initial?: MeshConfig): string {
  return renderToStaticMarkup(createElement(MeshBuilder, { store, onClose: () => {}, initial }));
}

test("MeshBuilder renders default auto-compact settings", () => {
  const html = render();

  expect(html).toContain("build.autoCompact");
  expect(html).toContain("build.autoCompact.enable");
  expect(html).toContain('type="checkbox" checked=""');
  expect(html).toContain('id="mesh-auto-compact-threshold"');
  expect(html).toContain('value="85%"');
  expect(html).toContain('placeholder="85%"');
});

test("MeshBuilder pre-fills existing auto-compact settings", () => {
  const html = render({ ...baseConfig, autoCompact: { enabled: false, threshold: "95%" } });

  expect(html).toContain('value="95%"');
  expect(html).toContain("disabled");
  expect(html).not.toContain('type="checkbox" checked=""');
});

test("MeshBuilder gives every agent tab a title and keeps + agent outside the tablist", () => {
  const html = render({
    ...baseConfig,
    agents: [
      { id: "router", harness: "claude", role: "router", project: "test_mesh_0" },
      { id: "worker", harness: "codex", role: "member", project: "test_mesh_0" },
    ],
    edges: [],
  });

  // router keeps its "(router)" title, and non-router tabs now carry a title too.
  expect(html).toContain('title="router (router)"');
  expect(html).toContain('title="worker"');
  // the add-agent button lives in its own wrapper, not inside role="tablist".
  const tablist = html.slice(html.indexOf('role="tablist"'), html.indexOf("builder-add-agent"));
  expect(tablist).not.toContain("+ agent");
  expect(html).toContain("builder-add-agent");
});

test("nextTabIndexForKey maps roving-tablist keys and ignores the rest", () => {
  // count = 3 tabs (overview + 2 agents)
  expect(nextTabIndexForKey("ArrowRight", 0, 3)).toBe(1);
  expect(nextTabIndexForKey("ArrowRight", 2, 3)).toBe(0); // wraps
  expect(nextTabIndexForKey("ArrowLeft", 0, 3)).toBe(2); // wraps
  expect(nextTabIndexForKey("ArrowLeft", 1, 3)).toBe(0);
  expect(nextTabIndexForKey("Home", 2, 3)).toBe(0);
  expect(nextTabIndexForKey("End", 0, 3)).toBe(2);
  expect(nextTabIndexForKey("Enter", 1, 3)).toBe(1);
  expect(nextTabIndexForKey(" ", 1, 3)).toBe(1);
  // keys the tablist must NOT consume — so a focused child (the remove button) can
  // keep its native Enter/Space activation instead of being preventDefault-ed.
  expect(nextTabIndexForKey("a", 1, 3)).toBeNull();
  expect(nextTabIndexForKey("Tab", 1, 3)).toBeNull();
  expect(nextTabIndexForKey("Escape", 1, 3)).toBeNull();
  expect(nextTabIndexForKey("ArrowRight", 0, 0)).toBeNull();
});

test("validateAutoCompactThresholdInput accepts valid formats and rejects invalid input", () => {
  expect(validateAutoCompactThresholdInput("70%")).toBeNull();
  expect(validateAutoCompactThresholdInput("200000 tokens")).toBeNull();
  expect(validateAutoCompactThresholdInput("-20000")).toBeNull();
  expect(validateAutoCompactThresholdInput("abc")).toMatch(/invalid compact threshold/);
});

test("validateAutoCompactSettingsInput skips threshold validation when disabled", () => {
  expect(validateAutoCompactSettingsInput(false, "")).toBeNull();
  expect(validateAutoCompactSettingsInput(false, "abc")).toBeNull();
  expect(validateAutoCompactSettingsInput(true, "abc")).toMatch(/invalid compact threshold/);
});
