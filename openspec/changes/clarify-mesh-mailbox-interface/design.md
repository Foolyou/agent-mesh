## Context

`mailbox.ts` exposes `defaultMailboxPath()` (= `AGENT_ROOM_MAILBOX || ".mesh/mailbox.ndjson"`)
and `sendMailboxEvent` (taskId default from `AGENT_ROOM_TASK_ID`). Only the legacy
PTY cluster uses these (`mailbox-send.ts`, `mailbox-tail.ts`, `mock-agent.ts`,
`pty-*.ts`, `work-packet.ts`, `codex-*-test.ts`). The live ACP path
(`control-plane.ts`) imports just `sendMail`/`readMailFor` and always passes an
explicit `<mesh>-mailbox.ndjson` path; members never touch the file — they call
the injected MCP `send_mail` tool and the control plane writes the file + wakes
the recipient. An impl agent introspecting the repo found the legacy defaults and
mistook them for the live interface.

## Goals / Non-Goals

**Goals:**
- Stop the codebase from misleading an introspecting member agent about how to
  communicate with its mesh.
- Make the live vs. legacy mailbox distinction obvious where it currently misleads.

**Non-Goals:**
- Moving/deleting the legacy PTY cluster (larger, riskier follow-up).
- Any change to the live mailbox/wake mechanism or MCP tool surface.

## Decisions

### Decision: Fix the symptom at the briefing, not by refactoring legacy code

The agent was misled while acting as a *member*, and every member receives the
mesh briefing on its first prompt. Adding explicit "use the MCP tools; not env
vars; not files" guidance there addresses the confusion regardless of what legacy
code exists in the tree.

- **Alternative considered — move/delete legacy PTY files now:** higher blast
  radius (touches demos + tests that still reference `mailbox-send.ts` and
  `AGENT_ROOM_*`), and unnecessary to fix the confusion. Deferred as a non-goal.

### Decision: Comment, don't restructure, `mailbox.ts`

A header comment delineating the two paths is enough to stop the misleading read.
Splitting the module or stripping the legacy defaults would break the legacy CLIs
that depend on them — out of scope here.

## Risks / Trade-offs

- **Briefing string change breaks content assertions** → Update
  `mesh-briefing.test.ts` in the same change.
- **Comment-only fix leaves the legacy code present** → Accepted; the misleading
  *signal* is removed, and full legacy isolation is a tracked follow-up.
