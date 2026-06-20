#!/usr/bin/env bash
# ── DEVELOPMENT agent-mesh instance ─────────────────────────────────────────────
# Runs from SOURCE (bun run src/main.ts), throwaway base (~/mesh-dev → data in
# ~/mesh-dev/.agent-mesh), web on http://localhost:10020. Restart / rebuild this freely to
# test changes — it never touches the production instance (10010) or its meshes (separate
# base + ports + sockets).
#
# Typical loop: edit code → run this → check http://localhost:10020 / run `bun test` →
# Ctrl-C → repeat. Or just run the suites directly (bun test, src/web/*.e2e.ts).
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${MESH_DEV_ROOT:-$HOME/mesh-dev}"        # base dir; data lives in <base>/.agent-mesh
PORT="${MESH_DEV_PORT:-10020}"
echo "dev agent-mesh → http://localhost:$PORT  (root $BASE/.agent-mesh, from source)"
exec bun run src/main.ts run --port "$PORT" --root "$BASE"
