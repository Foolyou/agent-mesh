# Mesh Assistant prompt — create the development mesh

Paste this into the **Mesh Assistant** chat on the production console
(http://localhost:10010). It will create and start a mesh of agents whose job is to
develop this very project.

---

Create and start a mesh called **`mesh-dev`** for developing the agent-mesh project
itself (this codebase). Three agents, each with working directory `.` (the repo root):

- **`lead`** — harness `claude`, role `router`. Breaks work into tasks, assigns ONE
  writer at a time, reviews diffs, decides when something is done.
- **`impl`** — harness `codex`, role `member`. Implements features and fixes.
- **`review`** — harness `opencode`, role `member`. Reviews changes, runs the tests/e2e.

Mail edges (both directions): `lead`↔`impl`, `lead`↔`review`, `impl`↔`review`.

Team charter (inject into every agent):

> **GOAL:** Iteratively develop and improve the agent-mesh controller — a Bun + React +
> TypeScript app that orchestrates meshes of heterogeneous coding agents over ACP, with
> a process-per-mesh (detachable daemon) model.
>
> **NORMS**
> - **TDD:** extend/write tests first; keep `bun test` green. Browser-test UI changes with
>   the Playwright e2e scripts in `src/web/*.e2e.ts` (they use bundled chromium).
> - **Commit often:** small, working commits on a feature branch, so an interruption costs
>   context, never work. End commit messages with a `Co-Authored-By: ...` line.
> - **Validate on DEV, never on production.** To check changes, run `bun test` + the e2e,
>   and for manual/browser checks start a throwaway dev instance:
>   `bun run src/main.ts --port 10020 --root ~/mesh-dev` (data → ~/mesh-dev/.agent-mesh; kill it when done).
>   **NEVER** restart, kill, or write into the production instance (port 10010, root
>   `~/.agent-mesh`) or its meshes. Do not touch `~/.agent-mesh`.
> - **One writer at a time:** `lead` serializes edits and has the writer commit before
>   handing off, so the shared checkout is never clobbered.
> - Match existing code style; prefer small, focused files; update the relevant
>   `*.e2e.ts` whenever behavior changes. Read `docs/dev-workflow.md` for the setup.

Then start the mesh and have `lead` introduce the team and wait for my first task.

---

**Tip:** if you'd rather each editor have its own checkout (no shared-tree contention),
first create git worktrees and point the agents at them — e.g. set `impl`'s project to
`worktrees/impl` and `review`'s to `worktrees/review` after `git worktree add`.
