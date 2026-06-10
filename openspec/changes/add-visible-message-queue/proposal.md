## Why

Queued mail and direct user prompts currently appear in an agent's transcript as soon as they are submitted, even when the agent is still busy and the prompt is only waiting in an internal ACP queue. This makes the conversation look ahead of the agent's actual context and hides useful queue state from the operator.

## What Changes

- Add a compact per-agent visible message queue above the composer.
- Show only the queued message count and the most recent queued message as one-line plain text.
- Keep queued messages out of the transcript until the agent actually starts processing that turn.
- Preserve steer behavior: operator steer queues ahead of ordinary messages, interrupts the current turn, and enters the transcript only when it starts.
- Keep the existing mail rail as an immediate delivery/activity stream.

## Non-goals

- No expandable queue list.
- No queue item cancellation, reordering, or manual drop controls.
- No daemon-crash persistence for direct operator prompts.
- No queue limits or flood-control policy in this change.
- No broad redesign of mail rails, activity rails, or transcript rendering.

## Capabilities

### New Capabilities

- `visible-message-queue`: Compact UI and event semantics for pending agent messages before they enter the transcript.

### Modified Capabilities

- None.

## Impact

- Backend event model: add minimal turn queued/started events for agent prompt turns.
- Web gateway state: store compact per-agent queue summaries and fold transcript entries on turn start instead of submission.
- Web client: render a small queue box above each composer.
- Tests: add reducer/gateway coverage for queued-vs-started behavior and update e2e expectations that currently assume immediate transcript echo.
- Process model: no change to dev/prod isolation. Queue state lives in the running mesh-host process and is replayed through existing backend reconnect mechanics; it is not persisted across daemon crash.
