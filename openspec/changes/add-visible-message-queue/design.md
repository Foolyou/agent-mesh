## Context

Today the ACP connection serializes prompt turns internally, but that queue is not visible to the Web UI. WebGateway also folds operator prompts and inter-agent mail into the transcript at submission time, so a busy agent's conversation can show messages that the agent has not started processing yet.

The narrow product goal is a compact queue box above the composer: show only the queued count and the most recent queued message preview, then move a message into the transcript when the turn starts.

## Goals / Non-Goals

**Goals:**

- Expose minimal per-agent queue state to the Web UI.
- Keep queued operator prompts and mail out of the transcript until the turn starts.
- Show `queued: N` and a one-line plain-text preview of the most recent queued message above the composer.
- Preserve existing steer semantics: priority queue ahead of ordinary prompts, cancel current turn, then start the steer turn when possible.

**Non-Goals:**

- No expandable queue list.
- No cancel/drop/reorder controls.
- No queue persistence across mesh-host daemon crash.
- No queue limit or flood control.
- No change to `check_mail` semantics.

## Decisions

1. **Use ControlPlane turn events as the WebGateway source of truth.**
   - Add minimal `agent_turn` events for queued and started turns.
   - WebGateway updates queue summaries on `queued` and folds transcript items only on `started`.
   - Alternative considered: infer from `agent_activity`. Rejected because `activity` currently merges active and queued work.

2. **Keep AcpAgentConnection as the low-level serializer.**
   - Add metadata/callbacks around enqueue and pump start rather than replacing the queue with a large ControlPlane queue.
   - This keeps the MVP small while still using the true dequeue/start point.
   - Alternative considered: full ControlPlane queue. Rejected for this iteration because the requested UI only needs count and last preview.

3. **Queue preview is plain text.**
   - The queue box renders a one-line escaped string, not Markdown.
   - This avoids injection/layout issues and matches the compact preview requirement.

4. **Queued count includes steer until it starts.**
   - Operator steer is a queued turn that increments the count, enters the priority segment, cancels the active turn, then decrements when started.
   - The cancelled turn is not requeued.

## Risks / Trade-offs

- Hidden queue remains process memory only -> direct operator prompts queued but not started can be lost on daemon crash. Mitigation: document as MVP limitation; mail still has mailbox durability.
- Transcript timing changes can break tests that expected immediate user bubbles -> update tests to assert queued first, transcript on start.
- Replayed events after backend reconnect must rebuild queue summaries -> include queued/started events in the existing mesh-host event ring and snapshot path.
