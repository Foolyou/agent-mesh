## ADDED Requirements

### Requirement: Briefing directs members to the MCP mesh tools

The mesh briefing injected into a member's first prompt SHALL instruct the member
to communicate using the injected MCP mesh tools (`send_mail`, `check_mail`, and
for the router `interrupt`/`mesh_status`). The briefing SHALL state that mesh
access is provided through those injected tools and SHALL NOT require or reference
environment variables or direct reading/writing of any mailbox file.

#### Scenario: Briefing tells a member how to communicate

- **WHEN** the briefing is built for a non-router member
- **THEN** it states that communication happens via the injected mesh tools and
  that the member should not look for environment variables or write a mailbox
  file directly

#### Scenario: Briefing does not point members at files or env

- **WHEN** the briefing is built for any agent
- **THEN** it does not instruct the agent to use an `AGENT_ROOM_*` environment
  variable or to access a mailbox file path directly

### Requirement: Mailbox module delineates live vs legacy paths

The shared mailbox module SHALL document, at the top of the file, the distinction
between the live ACP mesh path (control plane + MCP `send_mail`, called with an
explicit mailbox path, no environment variables) and the legacy PTY-CLI path
(`AGENT_ROOM_*` defaults used by `mailbox-send.ts`/`mailbox-tail.ts`), so a reader
is not misled by the legacy default values.

#### Scenario: Module header explains the two paths

- **WHEN** a developer or agent reads the top of `src/mailbox.ts`
- **THEN** a comment makes clear that the env-var/default-path helpers are for the
  legacy PTY CLI and that mesh members send mail via the MCP `send_mail` tool
