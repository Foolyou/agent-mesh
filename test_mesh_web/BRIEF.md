# Fictional task — wordcount CLI

Build a single-file Node script `wordcount.mjs` in this directory.

Requirements:
- Takes one CLI argument: a file path.
- Prints three numbers separated by spaces: `<lines> <words> <chars>` for that file
  (like a minimal `wc`).
- No external dependencies; pure Node.
- If the file is missing, print `error: <path> not found` to stderr and exit 1.

This brief exists so a mesh of agents (a Claude router coordinating a Codex
implementer and an OpenCode reviewer) has a small, concrete, bounded task to
collaborate on while we validate the web console end-to-end.
