// src/protocol.ts
// NDJSON control protocol between the parent MeshManager and each mesh-host
// subprocess, carried over a per-mesh Unix domain socket.
//
// The mesh-host is a DETACHABLE DAEMON: it owns the listening socket; the parent
// connects as a client and may disconnect (e.g. backend restart) and reconnect
// later. Events carry a monotonic `seq`; on (re)connect the parent sends `hello`
// with the last seq it saw and the host replays everything newer, so the parent's
// aggregated view is rebuilt seamlessly without losing the live agents.
import type { MeshEvent } from "./acp/types";
import type { PromptImageRef } from "./acp/types";

/** Bumped when the wire protocol changes incompatibly; a reconnecting parent that
 *  speaks a different version refuses to attach to an old daemon. */
export const PROTO_VERSION = 5;

export interface SeqEvent {
  seq: number;
  event: MeshEvent;
}

/** child (mesh-host) -> parent (MeshManager) */
export type ChildMsg =
  | { t: "ready" }
  | { t: "ack"; proto: number; running: boolean; seq: number }
  | { t: "event"; seq: number; event: MeshEvent }
  | { t: "replay"; events: SeqEvent[] }
  | { t: "snapshot"; events: MeshEvent[] }
  | { t: "stopped" };

/** parent (MeshManager) -> child (mesh-host) */
export type ParentMsg =
  | { t: "hello"; proto: number; resumeFrom: number }
  | { t: "prompt"; target: string; text: string; images?: PromptImageRef[] }
  | { t: "steer"; target: string; text: string; images?: PromptImageRef[] }
  | { t: "resolve"; requestId: string; optionId: string }
  | { t: "setMode"; target: string; modeId: string }
  | { t: "setModel"; target: string; modelId: string }
  | { t: "interrupt"; target: string }
  | { t: "wake"; target: string }
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
