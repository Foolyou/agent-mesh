// src/channels/assistant-gateway.ts
//
// Narrow seam the FeishuChannel uses to reach the central Mesh Assistant for authorized p2p DMs
// (device-auth Phase 5 / design §5.2), without binding the channel to the concrete MeshAssistant
// class — so the relay stays unit-testable with a fake and the assistant can evolve independently.
//
// v1 LOCKED DECISION: all authorized p2p users share ONE Mesh Assistant session (a single
// conversation / context). The assistant runs one turn at a time; the channel streams each turn's
// reply back to the p2p chat that initiated it, and serializes p2p turns so updates always map to the
// right chat. Per-user sessions are a later revisit.

import type { PromptImageRef } from "../acp/types";

export interface AssistantGateway {
  /** Is the Mesh Assistant usable right now (started + a harness selected)? p2p routing is gated on
   *  this; when false the channel replies with a short "assistant unavailable" notice and does not
   *  route. */
  available(): boolean;
  /** Feed a user message (optionally with image refs) to the shared assistant session. Resolves when
   *  the assistant's turn completes — that resolution IS the turn-idle boundary the channel uses to
   *  finalize the streamed outbound reply. */
  prompt(text: string, images?: PromptImageRef[]): Promise<void>;
  /** Subscribe to the assistant's streamed session updates (raw ACP update objects, same shape as a
   *  MeshEvent `update` payload). Returns an unsubscribe. */
  onAssistant(listener: (update: unknown) => void): () => void;
}

/** A gateway that is never available — injected when the Mesh Assistant is disabled (--no-assistant)
 *  so the channel uniformly handles "no assistant" via the notice path. */
export function unavailableAssistantGateway(): AssistantGateway {
  return {
    available: () => false,
    prompt: async () => {
      throw new Error("Mesh Assistant is not available");
    },
    onAssistant: () => () => {},
  };
}
