# Dev ↔ Production workflow (developing agent-mesh with agent-mesh)

Two isolated instances so iterating on the code never disturbs the agents doing the work.
They share nothing: separate **roots**, **ports**, and **sockets**.

> **Root convention:** `--root <dir>` names a **base** directory; data lives in
> `<dir>/.agent-mesh` inside it (like a project-local `.git`). With no `--root` the base is
> your home, so the default root is `~/.agent-mesh`. So `--root .` → `./.agent-mesh`.

| | Production ("work") | Development |
|---|---|---|
| Launch | `scripts/work.sh` | `scripts/dev.sh` |
| Code | **pinned binary** `dist/mesh` (frozen) | **source** `bun run src/main.ts` |
| Base (`--root`) | `~` → data `~/.agent-mesh` | `~/mesh-dev` → data `~/mesh-dev/.agent-mesh` |
| Web | http://localhost:10010 | http://localhost:10020 |
| Restart it? | rarely, and it's safe (daemons survive + reconnect) | freely — it's throwaway |
| Hosts | your **development mesh** (agents writing the code) | nothing durable — just for testing changes |

## Why this is reliable

- The production instance runs the **pinned binary**, so editing source, switching git
  branches, or rebuilding cannot affect the running process.
- Mesh hosts are **detachable daemons**: even when you *do* restart the production
  backend, the running meshes (and their agents) survive and the backend **reconnects +
  replays** on startup. So you never lose the work-in-progress agents.
- The dev instance is fully isolated (own root/ports/sockets), so restarting/rebuilding
  it can't collide with production.

## The loop

1. **Start production** once: `scripts/work.sh` → open http://localhost:10010.
2. In its **Mesh Assistant**, paste `docs/dev-mesh-prompt.md` to create + start the
   development mesh. Those agents iterate the codebase.
3. **Test changes** on the dev instance / suites — never on production:
   - `bun test` and the browser e2e (`bun run src/web/browser.e2e.ts`, etc.)
   - `scripts/dev.sh` for manual/browser checks at http://localhost:10020 (Ctrl-C when done)
4. **Adopt new controller code** into production when ready: `bun run build` then re-run
   `scripts/work.sh`. The dev-mesh daemons keep running across the swap.

## Operating the daemons

- `./dist/mesh ps` — list running mesh daemons (they survive backend restarts).
- `./dist/mesh kill <name>` / `--all` — reap a daemon (stops its agents cleanly).
- Only changing **mesh-host core** code (ACP client, MCP mesh-tools, mailbox, permission
  response) needs that mesh restarted — pick the moment, and rely on agents committing
  often so a restart costs context, not work.
