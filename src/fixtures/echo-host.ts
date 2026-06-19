// src/fixtures/echo-host.ts
// Test fixture: a real mesh-host DAEMON wired to a fake ControlPlane that just echoes
// each prompt back as a log event. Exercises the actual MeshHostDaemon (listen, hello/
// ack, replay, commands, stop) without spawning real agents.
import { dirname } from "node:path";
import { MeshHostDaemon } from "../mesh-host";
import { writeRecord, removeRecord } from "../mesh-registry";
import { PROTO_VERSION } from "../protocol";
import type { AgentConfig, MeshConfig, MeshEdge, MeshEvent } from "../acp/types";

let listener: ((e: MeshEvent) => void) | undefined;
const cp = {
  on(l: (e: MeshEvent) => void) {
    listener = l;
    return () => {
      listener = undefined;
    };
  },
  snapshotEvents() {
    const ts = "snapshot";
    return config.agents.flatMap((agent) => [
      { kind: "agent_status" as const, agent: agent.id, status: "ready" as const, ts },
      { kind: "agent_activity" as const, agent: agent.id, activity: "idle" as const, ts },
      { kind: "agent_capabilities" as const, agent: agent.id, image: true, ts },
      { kind: "agent_modes" as const, agent: agent.id, current: "default", available: [{ id: "default", name: "Default" }], ts },
      { kind: "agent_models" as const, agent: agent.id, current: "test-model", available: [{ id: "test-model", name: "Test Model" }], ts },
    ]);
  },
  async prompt(_target: string, text: string) {
    listener?.({ kind: "log", text: `echo:${text}`, ts: "t" });
    return {};
  },
  removeQueuedTurn(target: string, turnId: string) {
    listener?.({ kind: "log", text: `removeQueuedTurn:${target}:${turnId}`, ts: "t" });
    return true;
  },
  resolveDecision() {
    return true;
  },
  async setMode() {},
  async setModel() {},
  async setEffort() {},
  async steer(_target: string, text: string) {
    listener?.({ kind: "steer", from: "operator", to: _target, body: text, ts: "t" });
  },
  async interrupt() {},
  async newSession(target: string) {
    listener?.({ kind: "update", agent: target, update: { sessionUpdate: "__session_reset__" }, ts: "t" });
  },
  async newAllSessions() {
    listener?.({ kind: "log", text: "newAllSessions", ts: "t" });
  },
  async wakeAgent(target: string) {
    listener?.({ kind: "log", text: `wake:${target}`, ts: "t" });
  },
  async stopAgent(target: string) {
    listener?.({ kind: "agent_status", agent: target, status: "stopped", ts: "t" });
  },
  addEdge(edge: { from: string; to: string }) {
    listener?.({ kind: "log", text: `addEdge:${edge.from}->${edge.to}`, ts: "t" });
  },
  addAgent(agent: AgentConfig, edges: MeshEdge[] = []) {
    listener?.({ kind: "log", text: `addAgent:${agent.id}:${edges.map((e) => `${e.from}->${e.to}`).join(",")}`, ts: "t" });
  },
  async stop() {},
};

const socketPath = process.env.MESH_SOCK!;
const runDir = process.env.MESH_RUN_DIR ?? dirname(socketPath);
const config = JSON.parse(process.env.MESH_CONFIG ?? '{"name":"echo"}') as MeshConfig;
const daemon = new MeshHostDaemon(cp, {
  socketPath,
  onStopped: () => void removeRecord(runDir, config.name).finally(() => process.exit(0)),
});
await daemon.listen();
await writeRecord(runDir, { name: config.name, pid: process.pid, socketPath, proto: PROTO_VERSION, startedAt: "T" });
daemon.markReady();
