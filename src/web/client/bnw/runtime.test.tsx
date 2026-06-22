// Step 7.1-A — focused SSR tests for the new /bnw Runtime A views. Renders against a
// hand-built GatewayState fixture (no real store/WS) to assert real store fields surface:
// agent status, context usage waterline, pending badge, transcript items, fullscreen frame.
import { test, expect } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RuntimeOverview, RuntimeFocus } from "./runtime";
import type { GatewayState, PerMeshState, MeshSummary, TranscriptItem } from "../../types";
import type { Store } from "../store";
import { I18nContext, translate } from "../i18n";

// runtime body now goes through t() — render under an en I18nContext provider.
const EN = { lang: "en" as const, t: (k: string, v?: Record<string, string | number>) => translate(k, "en", v) };
const render = (el: ReactElement) => renderToStaticMarkup(createElement(I18nContext.Provider, { value: EN }, el));

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
  const out = render(<RuntimeOverview store={STUB} state={s} mesh="demo" />);
  expect(out).toContain("runtime · demo");
  expect(out).toContain("data-bnw-agents");
  expect(out).toContain("router");
  expect(out).toContain("codex-1");
  expect(out).toContain("80% context"); // usage waterline from store
  expect(out).toContain('role="progressbar"');
  expect(out).toContain('href="/bnw/mesh/demo/canvas"'); // real canvas deep link
  expect(out).toContain('href="/bnw/mesh/demo/agent/codex-1"'); // real focus deep link
});

test("RuntimeOverview: unknown mesh → not-found state", () => {
  const out = render(<RuntimeOverview store={STUB} state={state()} mesh="ghost" />);
  expect(out).toContain("mesh not found");
});

test("RuntimeFocus split: transcript + real selectors + composer + side summaries + fullscreen toggle", () => {
  const items: TranscriptItem[] = [
    { id: "m1", kind: "message", role: "user", text: "restart alpha", ts: "", complete: true },
    { id: "m2", kind: "message", role: "agent", text: "on it", ts: "", complete: true },
    { id: "t1", kind: "tool_call", toolCallId: "c1", title: "bun test", status: "completed", output: "1693 pass", ts: "", updatedTs: "" },
  ];
  const s = state({ demo: pm({
    transcripts: { router: { items, hasMore: false } },
    models: { router: { current: "opus-4.8", available: [{ id: "opus-4.8", name: "Opus 4.8" }, { id: "sonnet-4.6", name: "Sonnet 4.6" }] } },
    activity: [{ id: "a1", ts: "", kind: "mail", text: "→ codex-1" }],
    mail: [{ id: "ml1", ts: "", from: "router", to: "codex-1", body: "go" }],
    queues: { router: { count: 2, items: [{ id: "q1", source: "operator", preview: "next prompt", ts: "" }] } },
  }) });
  const out = render(<RuntimeFocus store={STUB} state={s} mesh="demo" agent="router" full={false} />);
  expect(out).toContain('data-bnw-focus="split"');
  expect(out).toContain("data-bnw-transcript");
  expect(out).toContain("restart alpha");
  expect(out).toContain("on it");
  expect(out).toContain("bun test"); // tool-call card (collapsed)
  expect(out).toContain("data-bnw-selectors"); // #10 real selectors
  expect(out).toContain('aria-label="router model"'); // real model <select>
  expect(out).toContain('aria-label="Message composer"'); // real composer
  expect(out).toContain('aria-label="message input"');
  expect(out).toContain('href="/bnw/mesh/demo/agent/router?full=1"'); // fullscreen toggle
  // SINGLE right context panel `<agent> · activity` with ACTIVITY + MAIL (no extra stub column)
  expect(out).toContain("data-bnw-context");
  expect(out).toContain("router · activity");
  expect(out).toContain(">activity<");
  expect(out).toContain(">mail<");
  // queue is a compact chip at the transcript top, not a right column
  expect(out).toContain("data-bnw-queue-chip");
  expect(out).toContain("queued · 2");
});

test("RuntimeFocus: #14 transcript items expose expand toggles", () => {
  const items: TranscriptItem[] = [
    { id: "th1", kind: "thought", text: "let me think about this carefully", ts: "", complete: true },
    { id: "t1", kind: "tool_call", toolCallId: "c1", title: "grep", status: "completed", input: "pattern", output: "match", ts: "", updatedTs: "" },
  ];
  const s = state({ demo: pm({ transcripts: { router: { items, hasMore: false } } }) });
  const out = render(<RuntimeFocus store={STUB} state={s} mesh="demo" agent="router" full={false} />);
  expect(out).toContain("data-bnw-expand");
  expect(out).toContain('aria-expanded="false"'); // collapsed by default
});

test("RuntimeFocus: C2 docked approval bar shows FIFO oldest + 还有 N + resolve options", () => {
  const s = state({ demo: pm({
    transcripts: { router: { items: [], hasMore: false } },
    pending: [
      { requestId: "r1", agent: "router", question: "write config.json?", options: [{ id: "allow", name: "Allow" }, { id: "deny", name: "Deny" }], ts: "1" },
      { requestId: "r2", agent: "router", question: "second one", options: [{ id: "allow", name: "Allow" }], ts: "2" },
    ],
  }) });
  const out = render(<RuntimeFocus store={STUB} state={s} mesh="demo" agent="router" full={false} />);
  expect(out).toContain("data-bnw-approval");
  expect(out).toContain("write config.json?"); // oldest only
  expect(out).not.toContain("second one"); // FIFO — the rest are summarized
  expect(out).toContain("1 more pending");
  expect(out).toContain('aria-label="resolve allow"');
});

test("RuntimeOverview: #18 lifecycle controls present; cold agent gets a real Wake", () => {
  const running = render(<RuntimeOverview store={STUB} state={state({ demo: pm() })} mesh="demo" />);
  expect(running).toContain("data-bnw-lifecycle");
  expect(running).toContain('aria-label="stop demo"'); // SUMMARY is running → Stop
  const coldSummary: MeshSummary = { ...SUMMARY, status: "stopped", agents: [{ id: "kimi-1", harness: "kimi", role: "member", status: "cold", activity: "idle" }] };
  const coldState: GatewayState = { meshes: [coldSummary], assistant: { status: "absent", transcript: [] }, perMesh: { demo: pm() } };
  const cold = render(<RuntimeOverview store={STUB} state={coldState} mesh="demo" />);
  expect(cold).toContain('aria-label="start strategy"'); // stopped → Start strategy
  expect(cold).toContain('aria-label="wake kimi-1"'); // cold agent → real Wake
});

test("RuntimeFocus full=1: switches to the full frame (no side summaries)", () => {
  const s = state({ demo: pm({ transcripts: { router: { items: [], hasMore: false } } }) });
  const out = render(<RuntimeFocus store={STUB} state={s} mesh="demo" agent="router" full={true} />);
  expect(out).toContain('data-bnw-focus="full"');
  expect(out).not.toContain('data-bnw-focus="split"');
  expect(out).toContain('href="/bnw/mesh/demo/agent/router"'); // exit-fullscreen toggle (no ?full=1)
});

test("RuntimeFocus: unknown agent → not-found state", () => {
  const out = render(<RuntimeFocus store={STUB} state={state()} mesh="demo" agent="ghost" full={false} />);
  expect(out).toContain("agent not found");
});
