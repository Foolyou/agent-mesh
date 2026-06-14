import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeshDetail } from "./MeshDetail";
import { I18nContext, translate } from "./i18n";
import type { GatewayState } from "../types";

const state: GatewayState = {
  meshes: [{
    name: "demo",
    defined: true,
    status: "running",
    router: "router",
    agents: [{ id: "router", harness: "codex", role: "router", status: "ready", activity: "idle" }],
    edges: [],
  }],
  assistant: { status: "absent", transcript: [] },
  perMesh: {
    demo: {
      config: { name: "demo", agents: [], edges: [] },
      transcripts: {},
      activity: [],
      mail: [],
      pending: [],
      history: [],
      modes: {},
      models: {},
      efforts: {},
      capabilities: {},
      usage: { router: { used: 86, size: 100, ts: new Date().toISOString() } },
      health: {},
      selfAwareness: {
        router: {
          silentTaskCompletes: { count: 2, lastAt: 2000 },
          nearLimit: { usagePercent: 0.9, ts: 1000 },
        },
      },
      queues: {},
      board: null,
    },
  },
};

const store = {
  getState: () => state,
  subscribe: () => () => {},
  listHarnesses: async () => [],
  uploadImages: async () => [],
  removeQueuedTurn: async () => {},
  interruptAgent: async () => {},
  promptRouter: async () => {},
  promptAgent: async () => {},
  steerAgent: async () => {},
  setEffort: async () => {},
  setMode: async () => {},
  setModel: async () => {},
  wakeAgent: async () => {},
  newAgentSession: async () => {},
  newAllSessions: async () => {},
  stopMesh: async () => {},
  deleteMesh: async () => {},
  startMesh: async () => {},
  respawnAgent: async () => {},
  getBoard: async () => ({ mesh: "", revision: 0, epicSeq: 0, taskSeq: 0, epics: [], tasks: [] }),
  boardCommand: async () => ({ board: { mesh: "", revision: 0, epicSeq: 0, taskSeq: 0, epics: [], tasks: [] }, change: {} }),
  ensureBoardLoaded: async () => {},
  isTranscriptInitialLoaded: () => true,
  loadInitialTranscript: async () => {},
};

test("MeshDetail renders context chip and self-awareness warnings in agent controls", () => {
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { lang: "en", t: (key, vars) => translate(key, "en", vars) } },
      createElement(MeshDetail, {
        state,
        store: store as any,
        meshName: "demo",
        selectedAgent: "router",
        onSelectAgent: () => {},
        fullscreen: false,
        onToggleFull: () => {},
        onDeleted: () => {},
        onEdit: () => {},
      }),
    ),
  );

  expect(html).toContain("ctx-chip-red");
  expect(html).toContain("ctx: 86% (compact pending)");
  expect(html).toContain("silent stop ×2");
  expect(html).toContain("Context near limit (90%)");
});
