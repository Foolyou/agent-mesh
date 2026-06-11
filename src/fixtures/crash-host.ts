// src/fixtures/crash-host.ts
// Test fixture: a mesh-host daemon that listens, becomes ready, then exits on its own
// (simulating a crash) so the parent's onExit/onClose reaping path can be exercised.
import { MeshHostDaemon } from "../mesh-host";
import type { MeshEvent } from "../acp/types";

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
  removeQueuedTurn() {
    return true;
  },
  resolveDecision() {
    return true;
  },
  async setMode() {},
  async setModel() {},
  async steer() {},
  async interrupt() {},
  async newSession() {},
  async newAllSessions() {},
  async wakeAgent() {},
  addEdge() {},
  addAgent() {},
  async stop() {},
};

const daemon = new MeshHostDaemon(cp, { socketPath: process.env.MESH_SOCK! });
await daemon.listen();
daemon.markReady();
setTimeout(() => process.exit(1), 100); // "crash" after going ready
