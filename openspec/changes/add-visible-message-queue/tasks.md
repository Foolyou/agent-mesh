## 1. Turn Queue Events

- [x] 1.1 Add turn queued/started event types with enough metadata for queue count and transcript fold.
- [x] 1.2 Emit queued and started events from the real prompt queue start point for normal prompts, mail wakes, and steer.
- [x] 1.3 Preserve existing steer priority and interrupt behavior while reflecting it in queue state.

## 2. Web State and UI

- [x] 2.1 Add per-agent queue summaries to WebGateway state, snapshots, and store reducer.
- [x] 2.2 Stop folding queued user prompts and mail into transcripts at submission/delivery time; fold them on turn started.
- [x] 2.3 Render the compact queue box above the composer with count and one-line plain-text latest preview.

## 3. Tests and Verification

- [x] 3.1 Add/update unit tests for queued-vs-started WebGateway behavior and store queue state.
- [x] 3.2 Update browser e2e expectations for queued messages and steer behavior.
- [x] 3.3 Run targeted tests plus relevant Web e2e checks.
