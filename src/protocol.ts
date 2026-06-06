// src/protocol.ts
// NDJSON control protocol between the parent MeshManager and each mesh-host
// subprocess, carried over a per-mesh Unix domain socket.
import type { MeshEvent } from "./acp/types";

/** child (mesh-host) -> parent (MeshManager) */
export type ChildMsg =
  | { t: "ready" }
  | { t: "event"; event: MeshEvent }
  | { t: "stopped" };

/** parent (MeshManager) -> child (mesh-host) */
export type ParentMsg =
  | { t: "prompt"; target: string; text: string }
  | { t: "resolve"; requestId: string; optionId: string }
  | { t: "setMode"; target: string; modeId: string }
  | { t: "interrupt"; target: string }
  | { t: "stop" };

export function encodeFrame(msg: ChildMsg | ParentMsg): string {
  return JSON.stringify(msg) + "\n";
}

/** Accumulates socket chunks and yields complete, non-blank lines. */
export class LineBuffer {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    return parts.filter((l) => l.trim().length > 0);
  }
}
