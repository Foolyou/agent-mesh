// src/mesh-host.ts
// Subprocess body for one mesh: instantiates a ControlPlane and bridges its
// event bus + command surface to a Unix socket spoken by the parent MeshManager.
// Run directly (bun src/mesh-host.ts) with env MESH_SOCK + MESH_CONFIG.
import net from "node:net";
import { ControlPlane } from "./control-plane";
import { LineBuffer, encodeFrame, type ParentMsg } from "./protocol";
import type { MeshConfig, MeshEvent } from "./acp/types";

/** The slice of ControlPlane the bridge depends on (keeps the bridge testable). */
export interface BridgeControlPlane {
  on(listener: (e: MeshEvent) => void): () => void;
  prompt(target: string, text: string): Promise<unknown>;
  resolveDecision(requestId: string, optionId: string, by?: "human" | "timeout"): boolean;
  setMode(target: string, modeId: string): Promise<void>;
  interrupt(target: string): Promise<void>;
  stop(): Promise<void>;
}

export function bridgeControlPlaneToSocket(
  cp: BridgeControlPlane,
  socket: net.Socket,
  opts: { signalReady?: boolean } = {},
): void {
  const send = (m: Parameters<typeof encodeFrame>[0]) => socket.write(encodeFrame(m));
  const unsubscribe = cp.on((event) => send({ t: "event", event }));

  let stopping = false;
  const lb = new LineBuffer();
  socket.setEncoding("utf8");
  socket.on("data", async (chunk: string) => {
    for (const line of lb.push(chunk)) {
      let msg: ParentMsg;
      try { msg = JSON.parse(line) as ParentMsg; } catch { continue; }
      switch (msg.t) {
        case "prompt":
          cp.prompt(msg.target, msg.text).catch(() => {});
          break;
        case "resolve":
          cp.resolveDecision(msg.requestId, msg.optionId, "human");
          break;
        case "setMode":
          cp.setMode(msg.target, msg.modeId).catch(() => {});
          break;
        case "interrupt":
          cp.interrupt(msg.target).catch(() => {});
          break;
        case "stop":
          if (stopping) break;
          stopping = true;
          unsubscribe();
          await cp.stop().catch(() => {});
          send({ t: "stopped" });
          socket.destroy();
          break;
      }
    }
  });
  socket.on("close", () => unsubscribe());

  if (opts.signalReady !== false) send({ t: "ready" });
}

// --- entrypoint (only when executed as a subprocess) ----------------------
if (import.meta.main) {
  const sockPath = process.env.MESH_SOCK;
  const configJson = process.env.MESH_CONFIG;
  if (!sockPath || !configJson) {
    console.error("mesh-host: MESH_SOCK and MESH_CONFIG are required");
    process.exit(2);
  }
  const config = JSON.parse(configJson) as MeshConfig;
  const cp = new ControlPlane(config, { debug: process.env.MESH_DEBUG === "1" });
  const socket = net.connect(sockPath);
  socket.on("close", () => cp.stop().finally(() => process.exit(0)));
  await new Promise<void>((res) => socket.once("connect", res));
  // Subscribe + handle commands BEFORE start so startup events are forwarded,
  // but defer the ready signal until agents are actually up.
  bridgeControlPlaneToSocket(cp, socket, { signalReady: false });
  await cp.start();
  socket.write(encodeFrame({ t: "ready" }));
}
