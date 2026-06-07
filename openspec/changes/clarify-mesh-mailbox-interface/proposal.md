## Why

A mesh member (codex/impl) trying to report a result went looking for
`AGENT_ROOM_MAILBOX`/`AGENT_NAME` env vars and a mailbox file path to write to,
because those are the defaults exposed by the shared `mailbox.ts` module. But
the live ACP mesh does not use any of that: members communicate solely by calling
the injected MCP tools (`send_mail`/`check_mail`/...), and the control plane owns
the mailbox file + recipient wake-up. The env-var/default-path/file-append API is
the **legacy PTY prototype** path (README marks it retained-but-unused). Because
our agents develop this very repo, an agent that greps the code is actively
misled about how to talk to its own mesh.

## What Changes

- The mesh briefing SHALL tell members explicitly *how* to communicate: use the
  injected MCP mesh tools; mesh access is via those tools, **not** environment
  variables and **not** by reading/writing any mailbox file directly. Soften the
  "shared mailbox" wording that implies a file the agent must find.
- `src/mailbox.ts` SHALL carry a header comment that delineates the two paths —
  the live ACP path (control plane + MCP `send_mail`, explicit path, no env) vs.
  the legacy PTY-CLI path (`AGENT_ROOM_*` defaults, `mailbox-send.ts`/
  `mailbox-tail.ts`) — so readers are not misled by the legacy defaults.

Non-goals (deliberately out of scope to keep the change low-risk):
- Moving or deleting the legacy PTY cluster (`pty-*.ts`, `mock-agent.ts`,
  `work-packet.ts`, `mailbox-send.ts`, `mailbox-tail.ts`, `codex-*-test.ts`).
  That is a larger follow-up; this change only stops the misleading signal.
- Changing the live mailbox/wake mechanism or the MCP tool surface.

## Capabilities

### New Capabilities
- `mesh-mailbox-interface`: how mesh members are told to communicate (injected
  MCP tools, not env vars or direct file access), and how the codebase signals
  the live vs. legacy mailbox paths so it does not mislead an introspecting agent.

### Modified Capabilities
<!-- None — no existing spec covers the mesh briefing / mailbox interface yet. -->

## Impact

- **Code**: `src/mesh-briefing.ts` (briefing text), `src/mesh-briefing.test.ts`
  (assert the new guidance), `src/mailbox.ts` (clarifying header comment only —
  no behavior change).
- **Behavior**: no runtime behavior change to mail delivery or wake; this is a
  guidance/clarity change. The briefing string changes, so any test asserting on
  briefing content must be updated.
- **Dev/prod isolation & process model**: no impact — confined to briefing text
  and a comment. Verify via `bun test` (DEV-only rule still applies for any
  manual check).
