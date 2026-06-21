// Step 7.1-C — focused SSR tests for the /bnw topology canvas. Renders against a fixture
// GatewayState (no store/WS) to assert real edges → directed arrows, recent-mail highlight,
// nodes, force-directed toolbar, add-agent/edge controls, and the Esc-close affordance.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MeshCanvas } from "./canvas";
import type { GatewayState, PerMeshState, MeshSummary } from "../../types";
import type { Store } from "../store";

function pm(partial: Partial<PerMeshState> = {}): PerMeshState {
  return {
    config: { name: "demo", agents: [], edges: [] },
    transcripts: {}, activity: [], mail: [], pending: [], history: [],
    modes: {}, models: {}, efforts: {}, capabilities: {}, usage: {}, health: {},
    selfAwareness: {}, queues: {}, board: null, ...partial,
  };
}
const SUMMARY: MeshSummary = {
  name: "demo", defined: true, status: "running", router: "router",
  agents: [
    { id: "router", harness: "claude", role: "router", status: "ready", activity: "idle" },
    { id: "codex-1", harness: "codex", role: "member", status: "ready", activity: "working" },
    { id: "kimi-1", harness: "kimi", role: "member", status: "cold", activity: "idle" },
  ],
  edges: [{ from: "router", to: "codex-1" }, { from: "router", to: "kimi-1" }],
};
function state(perMesh: Record<string, PerMeshState> = {}): GatewayState {
  return { meshes: [SUMMARY], assistant: { status: "absent", transcript: [] }, perMesh };
}
const STUB = { wakeAgent: async () => {}, stopAgent: async () => {}, addAgent: async () => {}, addEdge: async () => {} } as unknown as Store;

test("MeshCanvas: real edges → directed arrows + recent-mail highlight + nodes", () => {
  const s = state({ demo: pm({ mail: [{ id: "m1", ts: "", from: "router", to: "codex-1", body: "go" }] }) });
  const out = renderToStaticMarkup(<MeshCanvas store={STUB} state={s} mesh="demo" />);
  expect(out).toContain("data-bnw-canvas");
  expect(out).toContain("data-bnw-edges");
  expect(out).toContain('id="bnw-arrow"'); // direction marker
  expect(out).toContain('id="bnw-arrow-recent"');
  expect(out).toContain('data-edge-recent="true"'); // router->codex-1 has recent mail
  expect(out).toContain("animate-pulse"); // recent edge pulses
  // a node card per agent (3) — match the card attr, not data-bnw-node-drag
  expect((out.match(/data-bnw-node="true"/g) ?? []).length).toBe(3);
  expect(out).toContain("router");
  expect(out).toContain("codex-1");
  expect(out).toContain("1 活跃"); // header recent count
});

test("MeshCanvas: force-directed toolbar (default on) + zoom/fit + Esc close", () => {
  const out = renderToStaticMarkup(<MeshCanvas store={STUB} state={state()} mesh="demo" />);
  expect(out).toContain("data-bnw-autolayout");
  expect(out).toContain('aria-label="force-directed layout"');
  expect(out).toContain('checked=""'); // default on
  expect(out).toContain("data-bnw-relayout");
  expect(out).toContain('aria-label="zoom in"');
  expect(out).toContain('aria-label="fit to window"');
  expect(out).toContain('aria-label="close canvas"');
  expect(out).toContain('href="/bnw/mesh/demo"'); // Esc → overview
});

test("MeshCanvas: per-node stop/wake/actions + #17 add-agent/edge controls", () => {
  const out = renderToStaticMarkup(<MeshCanvas store={STUB} state={state()} mesh="demo" />);
  expect(out).toContain('aria-label="stop codex-1"'); // running member → stop
  expect(out).toContain('aria-label="wake kimi-1"'); // cold member → wake
  expect(out).toContain('aria-label="router actions"'); // ⋯ → focus
  expect(out).toContain("data-bnw-topology");
  expect(out).toContain('aria-label="add agent"');
  expect(out).toContain('aria-label="add edge"');
});

test("MeshCanvas: unknown mesh → not-found", () => {
  const out = renderToStaticMarkup(<MeshCanvas store={STUB} state={state()} mesh="ghost" />);
  expect(out).toContain("mesh 不存在");
});
