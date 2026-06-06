# Agent Mesh

PTY-first prototype for Agent Room / Agent Mesh.

The prototype starts an agent CLI inside a real pseudo-terminal through the
system `script` command, sends it a work packet, and asks the agent to write
structured status updates to a mailbox file. Terminal output is still captured
for observation, but mailbox events are treated as the reliable coordination
channel.

## Demo

```bash
bun install
bun run demo
```

Requires the util-linux `script` command, which is normally available on Linux.

The demo runs a mock agent and writes mailbox events to:

```text
.mesh/mailbox.ndjson
```

Watch mailbox events:

```bash
bun run mailbox:tail
```

Run a real CLI agent through the PTY runner:

```bash
bun run start -- --agent "claude" --agent-name ClaudePTY --role "Reviewer Agent" --task "Review the current repo and report findings through the mailbox."
```

Run the two-step Codex continuation test:

```bash
bun run demo:codex:two-step
```

This keeps a single interactive Codex PTY session alive, sends part 1, waits for
a mailbox `result`, inspects the artifact on the host side, and then sends part
2 into the same PTY session.

Run a three-step product workflow with real Codex:

```bash
bun run demo:codex:calculator
```

This asks Codex to build a static calculator, waits for a mailbox result and
host-side checks, then asks the same PTY session to add dark mode, and finally
asks it to add unit conversion. Codex receives only one stage at a time; the
host-side orchestrator withholds the next prompt until the previous stage has
sent a mailbox `result` and passed verification.

The runner injects instructions that tell the agent to send stage/result events
with:

```bash
bun run src/mailbox-send.ts --from "ClaudePTY" --type stage --phase planning <<'AGENT_ROOM_BODY'
message body
AGENT_ROOM_BODY
```
