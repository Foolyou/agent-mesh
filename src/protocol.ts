// src/protocol.ts
// NDJSON control protocol between the parent MeshManager and each mesh-host
// subprocess, carried over a per-mesh Unix domain socket.
//
// The mesh-host is a DETACHABLE DAEMON: it owns the listening socket; the parent
// connects as a client and may disconnect (e.g. backend restart) and reconnect
// later. Events carry a monotonic `seq`; on (re)connect the parent sends `hello`
// with the last seq it saw and the host replays everything newer, so the parent's
// aggregated view is rebuilt seamlessly without losing the live agents.
import type { AgentConfig, MeshEdge, MeshEvent } from "./acp/types";
import type { RespawnMode, RespawnResult } from "./control-plane";
import type { PromptImageRef } from "./acp/types";
import type { BoardActor, BoardCommand, BoardCommandResult } from "./board";

/** Bumped when the wire protocol changes incompatibly; a reconnecting parent that
 *  speaks a different version refuses to attach to an old daemon.
 *  13: config mutations (setMode/setModel/setEffort) carry a reqId and are acked with a
 *      `cmdResult` frame; hard bump (no dual-mode).
 *  14: collaboration board — `board` command (reqId/actor/command/expectedBoardRevision)
 *      acked with a `boardResult` frame, and `board_snapshot` events stream the full board. */
export const PROTO_VERSION = 14;

export interface SeqEvent {
  seq: number;
  event: MeshEvent;
}

/** How strongly the host could confirm a config mutation actually took effect.
 *  - `applied_by_acp`: the host awaited the ACP call (e.g. setSessionMode) to completion.
 *  - `accepted_by_host`: the host forwarded the mutation but the ACP upstream gives no
 *    tracked response (raw config writes for model/effort), so "applied" cannot be claimed. */
export type MutationAckStatus = "applied_by_acp" | "accepted_by_host";

/** child (mesh-host) -> parent (MeshManager) */
export type ChildMsg =
  | { t: "ready" }
  | { t: "ack"; proto: number; running: boolean; seq: number }
  | { t: "event"; seq: number; event: MeshEvent }
  | { t: "replay"; events: SeqEvent[] }
  | { t: "snapshot"; events: MeshEvent[] }
  | { t: "respawnResult"; reqId: string; result?: RespawnResult; error?: string }
  | { t: "cmdResult"; reqId: string; status?: MutationAckStatus; error?: string }
  | { t: "boardResult"; reqId: string; result?: BoardCommandResult; error?: string }
  | { t: "stopped" };

/** parent (MeshManager) -> child (mesh-host) */
export type ParentMsg =
  | { t: "hello"; proto: number; resumeFrom: number }
  | { t: "prompt"; target: string; text: string; images?: PromptImageRef[] }
  | { t: "removeQueuedTurn"; target: string; turnId: string }
  | { t: "steer"; target: string; text: string; images?: PromptImageRef[] }
  | { t: "resolve"; requestId: string; optionId: string }
  | { t: "setMode"; target: string; modeId: string; reqId: string }
  | { t: "setModel"; target: string; modelId: string; reqId: string }
  | { t: "setEffort"; target: string; effort?: string; reqId: string }
  | { t: "interrupt"; target: string }
  | { t: "newSession"; target: string }
  | { t: "respawn"; reqId: string; target: string; mode: RespawnMode }
  | { t: "board"; reqId: string; actor: BoardActor; command: BoardCommand; expectedBoardRevision: number }
  | { t: "newAllSessions" }
  | { t: "wake"; target: string }
  | { t: "stopAgent"; target: string }
  | { t: "addEdge"; edge: MeshEdge }
  | { t: "addAgent"; agent: AgentConfig; edges?: MeshEdge[] }
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
