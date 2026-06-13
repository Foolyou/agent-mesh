import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeshBuilder, validateAutoCompactThresholdInput } from "./MeshBuilder";
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

test("validateAutoCompactThresholdInput accepts valid formats and rejects invalid input", () => {
  expect(validateAutoCompactThresholdInput("70%")).toBeNull();
  expect(validateAutoCompactThresholdInput("200000 tokens")).toBeNull();
  expect(validateAutoCompactThresholdInput("-20000")).toBeNull();
  expect(validateAutoCompactThresholdInput("abc")).toMatch(/invalid compact threshold/);
});
