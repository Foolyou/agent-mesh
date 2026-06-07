## 1. Briefing guidance

- [ ] 1.1 In `src/mesh-briefing.ts`, add explicit guidance to the mesh-tools section: members communicate via the injected MCP tools; mesh access is through those tools — do NOT look for `AGENT_ROOM_*` env vars and do NOT read/write any mailbox file directly. Soften the "shared mailbox" wording (line ~32) that implies a file to find.
- [ ] 1.2 Update `src/mesh-briefing.test.ts` to assert the new guidance is present and that the briefing does not reference env vars / direct file access.

## 2. Mailbox module clarity

- [ ] 2.1 Add a header comment to `src/mailbox.ts` delineating the live ACP path (control plane + MCP `send_mail`, explicit path, no env) from the legacy PTY-CLI path (`AGENT_ROOM_*` defaults used by `mailbox-send.ts`/`mailbox-tail.ts`). Comment only — no behavior change.

## 3. Verify & commit

- [ ] 3.1 Run `bun test` — all green (briefing + mailbox tests included).
- [ ] 3.2 Commit on a feature branch with a Co-Authored-By trailer.
