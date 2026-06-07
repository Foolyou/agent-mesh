#!/usr/bin/env bash
# ── DEVELOPMENT agent-mesh instance ─────────────────────────────────────────────
# Runs from SOURCE (bun run src/main.ts), throwaway root (~/.agent-mesh-dev), web on
# http://localhost:10020. Restart / rebuild this freely to test changes — it never
# touches the production instance (10010) or its meshes (separate root + ports + sockets).
#
# Typical loop: edit code → run this → check http://localhost:10020 / run `bun test` →
# Ctrl-C → repeat. Or just run the suites directly (bun test, src/web/*.e2e.ts).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="${MESH_DEV_ROOT:-$HOME/.agent-mesh-dev}"
PORT="${MESH_DEV_PORT:-10020}"
echo "dev agent-mesh → http://localhost:$PORT  (root $ROOT, from source)"
exec bun run src/main.ts --port "$PORT" --root "$ROOT"
