#!/usr/bin/env bash
# ── PRODUCTION / "actual work" agent-mesh instance ──────────────────────────────
# Runs the PINNED BINARY (dist/mesh) so editing source / switching branches / rebuilding
# can't disturb it. Stable root (~/.agent-mesh), web console on http://localhost:10010.
# This is the durable home for your development mesh.
#
# Restarting this is SAFE: running mesh daemons survive and the backend reconnects on
# start (you'll see "reattached to running mesh(es)"). To adopt newer controller code,
# `bun run build` then re-run this — the daemons keep running across the swap.
#
# Build the binary first:  bun run build
set -euo pipefail
cd "$(dirname "$0")/.."                       # repo root = the dev mesh agents' working dir
ROOT="${MESH_WORK_ROOT:-$HOME/.agent-mesh}"
PORT="${MESH_WORK_PORT:-10010}"
[ -x ./dist/mesh ] || { echo "dist/mesh missing — run: bun run build" >&2; exit 1; }
echo "production agent-mesh → http://localhost:$PORT  (root $ROOT, pinned binary)"
exec ./dist/mesh --port "$PORT" --root "$ROOT"
