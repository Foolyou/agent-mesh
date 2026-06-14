import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeshCanvas } from "./MeshCanvas";
import type { Store } from "./store";
import type { GatewayState, MeshSummary, PerMeshState, TranscriptItem } from "../types";

const T = "2026-06-09T00:00:00.000Z";

function messages(agent: string, count: number): TranscriptItem[] {
  return Array.from({ length: count }, (_, i): TranscriptItem => ({
    id: `${agent}-msg-${i}`,
    kind: "message",
    role: i % 2 ? "agent" : "user",
    text: `${agent} message ${i}`,
    complete: true,
    ts: T,
  }));
}

function mesh(): MeshSummary {
  const agents = ["agent-0", "agent-1", "agent-2", "agent-3", "agent-4"].map((id) => ({
    id,
    harness: "codex" as const,
    role: "member" as const,
    status: "ready" as const,
    activity: "idle" as const,
  }));
  return { name: "canvas-load", defined: true, status: "running", router: "agent-0", agents, edges: [] };
}

function perMesh(m: MeshSummary): PerMeshState {
  return {
    config: { name: m.name, agents: [], edges: [] },
    transcripts: Object.fromEntries(m.agents.map((agent) => [agent.id, { items: messages(agent.id, 250), hasMore: false, oldestSeq: `${agent.id}-msg-0` }])),
    activity: [],
    mail: [],
    pending: [],
    history: [],
    modes: {},
    models: {},
    efforts: {},
    capabilities: {},
    usage: {},
    health: {},
    selfAwareness: {},
    queues: {},
    board: null,
  };
}

function store(state: GatewayState): Store {
  const noop = async () => undefined;
  const mutationNoop = async () => ({ saved: true, applied: true, ackStatus: "applied_by_acp" as const });
  return {
    getState: () => state,
    subscribe: () => () => {},
    wsConnected: () => true,
    getToasts: () => [],
    getUpgrade: () => ({ available: false }),
    apply: () => {},
    dismissToast: () => {},
    startMesh: noop,
    stopMesh: noop,
    reload: noop,
    defineMesh: noop,
    deleteMesh: noop,
    uploadImages: async () => [],
    promptRouter: noop,
    promptAgent: noop,
    removeQueuedTurn: noop,
    steerAgent: noop,
    promptAssistant: noop,
    resolvePermission: noop,
    setMode: mutationNoop,
    setModel: mutationNoop,
    setEffort: mutationNoop,
    addEdge: noop,
    addAgent: noop,
    interruptAgent: noop,
    wakeAgent: noop,
    stopAgent: noop,
    newAgentSession: noop,
    newAllSessions: noop,
    respawnAgent: noop,
    getBoard: async () => ({ mesh: "", revision: 0, epicSeq: 0, taskSeq: 0, epics: [], tasks: [] }),
    boardCommand: async () => ({ board: { mesh: "", revision: 0, epicSeq: 0, taskSeq: 0, epics: [], tasks: [] }, change: {} }),
    isTranscriptInitialLoaded: () => true,
    loadInitialTranscript: noop,
    loadOlderTranscript: noop,
    listHarnesses: async () => [],
    installHarness: async () => ({ jobId: "job", status: "done" as const, harnessId: "codex", pkgSpec: "codex" }),
    streamHarnessInstall: noop,
    reprobeHarness: noop,
    interruptAssistant: noop,
  };
}

test("MeshCanvas keeps full transcript only for the focused window and tails the rest", () => {
  const m = mesh();
  const pm = perMesh(m);
  const state: GatewayState = { meshes: [m], assistant: { status: "absent", transcript: [] }, perMesh: { [m.name]: pm } };
  const html = renderToStaticMarkup(createElement(MeshCanvas, { m, pm, store: store(state), onClose: () => {}, onEdit: () => {}, onDeleted: () => {} }));

  expect(html).toContain('data-agent="agent-4"');
  expect(html).toContain('data-transcript-mode="full"');
  expect(html).toContain('data-transcript-total="250"');
  expect(html).toContain('data-transcript-rendered="250"');
  expect((html.match(/data-transcript-mode="tail"/g) ?? []).length).toBe(4);
  expect((html.match(/data-transcript-rendered="30"/g) ?? []).length).toBe(4);
  expect((html.match(/class="msg /g) ?? []).length).toBeLessThan(160);
  expect(html).toContain("agent-1 message 249");
  expect(html).not.toContain("agent-1 message 0");
});
