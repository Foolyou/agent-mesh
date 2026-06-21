// Step 7.1-A — focused SSR tests for the new /bnw Runtime A views. Renders against a
// hand-built GatewayState fixture (no real store/WS) to assert real store fields surface:
// agent status, context usage waterline, pending badge, transcript items, fullscreen frame.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RuntimeOverview, RuntimeFocus } from "./runtime";
import type { GatewayState, PerMeshState, MeshSummary, TranscriptItem } from "../../types";
import type { Store } from "../store";

function pm(partial: Partial<PerMeshState> = {}): PerMeshState {
  return {
    config: { name: "demo", agents: [], edges: [] },
    transcripts: {}, activity: [], mail: [], pending: [], history: [],
    modes: {}, models: {}, efforts: {}, capabilities: {}, usage: {}, health: {},
    selfAwareness: {}, queues: {}, board: null,
    ...partial,
  };
}
const SUMMARY: MeshSummary = {
  name: "demo", defined: true, status: "running", router: "router",
  agents: [
    { id: "router", harness: "claude", role: "router", status: "ready", activity: "idle" },
    { id: "codex-1", harness: "codex", role: "member", status: "ready", activity: "working" },
  ],
  edges: [],
};
function state(perMesh: Record<string, PerMeshState> = {}): GatewayState {
  return { meshes: [SUMMARY], assistant: { status: "absent", transcript: [] }, perMesh };
}
const STUB = {
  isTranscriptInitialLoaded: () => true,
  loadInitialTranscript: async () => {},
  loadOlderTranscript: async () => {},
} as unknown as Store;

test("RuntimeOverview: agents + status + usage waterline + pending + canvas link (real fields)", () => {
  const s = state({ demo: pm({
    usage: { router: { used: 80000, size: 100000, ts: "" } },
    pending: [{ requestId: "r1", agent: "router", question: "approve?", options: [], ts: "" }],
  }) });
  const out = renderToStaticMarkup(<RuntimeOverview store={STUB} state={s} mesh="demo" />);
  expect(out).toContain("运行态 · demo");
  expect(out).toContain("data-bnw-agents");
  expect(out).toContain("router");
  expect(out).toContain("codex-1");
  expect(out).toContain("80% context"); // usage waterline from store
  expect(out).toContain('role="progressbar"');
  expect(out).toContain('href="/bnw/mesh/demo/canvas"'); // real canvas deep link
  expect(out).toContain('href="/bnw/mesh/demo/agent/codex-1"'); // real focus deep link
});

test("RuntimeOverview: unknown mesh → not-found state", () => {
  const out = renderToStaticMarkup(<RuntimeOverview store={STUB} state={state()} mesh="ghost" />);
  expect(out).toContain("mesh 不存在");
});

test("RuntimeFocus split: transcript items + side summaries + fullscreen toggle link", () => {
  const items: TranscriptItem[] = [
    { id: "m1", kind: "message", role: "user", text: "restart alpha", ts: "", complete: true },
    { id: "m2", kind: "message", role: "agent", text: "on it", ts: "", complete: true },
    { id: "t1", kind: "tool_call", toolCallId: "c1", title: "bun test", status: "completed", output: "1693 pass", ts: "", updatedTs: "" },
  ];
  const s = state({ demo: pm({
    transcripts: { router: { items, hasMore: false } },
    models: { router: { current: "opus-4.8", available: [] } },
    activity: [{ id: "a1", ts: "", kind: "mail", text: "→ codex-1" }],
  }) });
  const out = renderToStaticMarkup(<RuntimeFocus store={STUB} state={s} mesh="demo" agent="router" full={false} />);
  expect(out).toContain('data-bnw-focus="split"');
  expect(out).toContain("data-bnw-transcript");
  expect(out).toContain("restart alpha");
  expect(out).toContain("on it");
  expect(out).toContain("bun test"); // tool-call card
  expect(out).toContain("model: opus-4.8"); // read-only selector value from store
  expect(out).toContain('href="/bnw/mesh/demo/agent/router?full=1"'); // fullscreen toggle
  expect(out).toContain("活动"); // side summary
});

test("RuntimeFocus full=1: switches to the full frame (no side summaries)", () => {
  const s = state({ demo: pm({ transcripts: { router: { items: [], hasMore: false } } }) });
  const out = renderToStaticMarkup(<RuntimeFocus store={STUB} state={s} mesh="demo" agent="router" full={true} />);
  expect(out).toContain('data-bnw-focus="full"');
  expect(out).not.toContain('data-bnw-focus="split"');
  expect(out).toContain('href="/bnw/mesh/demo/agent/router"'); // exit-fullscreen toggle (no ?full=1)
});

test("RuntimeFocus: unknown agent → not-found state", () => {
  const out = renderToStaticMarkup(<RuntimeFocus store={STUB} state={state()} mesh="demo" agent="ghost" full={false} />);
  expect(out).toContain("agent 不存在");
});
