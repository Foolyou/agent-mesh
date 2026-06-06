// Shared types for the WebUI: aggregated transcript items, gateway state, and the
// WebSocket wire protocol. These are the contract between WebGateway (server) and
// the client store.

// ── Aggregated transcript ────────────────────────────────────────────────────
// A transcript folds the raw ACP SessionUpdate stream into ordered, identity-keyed
// items so the UI renders coherent message bubbles / tool-call cards instead of one
// line per raw event.

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type TranscriptItem =
  | { id: string; kind: "message"; role: "user" | "agent"; text: string; ts: string; complete: boolean }
  | { id: string; kind: "thought"; text: string; ts: string; complete: boolean }
  | {
      id: string;
      kind: "tool_call";
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: ToolCallStatus;
      output?: string;
      ts: string;
      updatedTs: string;
    };

export type TranscriptOp =
  | { op: "upsert"; item: TranscriptItem }
  | { op: "patch"; id: string; patch: Partial<TranscriptItem> };
