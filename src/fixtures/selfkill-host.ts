// src/fixtures/selfkill-host.ts
// Repro fixture: a mesh-host daemon that, like the real ControlPlane, kills its "agent"
// child process tree when it stops. Used to reproduce the scenario where a COLD restart
// is invoked from INSIDE a mesh: reaping the daemon kills the agent (and the restart
// script it's running) before the backend is restarted.
//
// Env: MESH_SOCK / MESH_CONFIG (set by the host client), plus MESH_AGENT_CMD = a shell
// command to run as the simulated agent (a child of this daemon).
import { dirname } from "node:path";
import { MeshHostDaemon } from "../mesh-host";
import { killTree } from "../acp/client";
import { writeRecord, removeRecord } from "../mesh-registry";
import { PROTO_VERSION } from "../protocol";
import type { MeshConfig, MeshEvent } from "../acp/types";

let childPid = 0;
const cp = {
  on(_l: (e: MeshEvent) => void) {
    return () => {};
  },
  snapshotEvents() {
    return [];
  },
  async prompt() {
    return {};
  },
  resolveDecision() {
    return true;
  },
  async setMode() {},
  async setModel() {},
  async steer() {},
  async interrupt() {},
  async wakeAgent() {},
  addEdge() {},
  addAgent() {},
  async stop() {
    if (childPid) killTree(childPid); // reap the "agent" tree, exactly like ControlPlane.stop()
  },
};

const socketPath = process.env.MESH_SOCK!;
const runDir = dirname(socketPath);
const config = JSON.parse(process.env.MESH_CONFIG ?? '{"name":"x"}') as MeshConfig;
const daemon = new MeshHostDaemon(cp, {
  socketPath,
  onStopped: () => void removeRecord(runDir, config.name).finally(() => process.exit(0)),
});
await daemon.listen();
await writeRecord(runDir, { name: config.name, pid: process.pid, socketPath, proto: PROTO_VERSION, startedAt: "T" });
daemon.markReady();
// faithful to runMeshHost(): SIGTERM → daemon.stop() → cp.stop() → reap the agent tree
process.on("SIGTERM", () => void daemon.stop());

// Spawn the simulated "agent" as a child, which runs the restart command from INSIDE the
// mesh (a descendant of this daemon) — so reaping this daemon kills it mid-run.
if (process.env.MESH_AGENT_CMD) {
  const child = Bun.spawn(["bash", "-lc", process.env.MESH_AGENT_CMD!], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  childPid = child.pid;
}
