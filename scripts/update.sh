#!/usr/bin/env bash
# Update (deploy) or roll back the user-local agent-mesh binary.
#
#   scripts/update.sh                 verify latest source → build a self-contained binary →
#                                     install it as ~/.local/bin/mesh → restart with it
#   scripts/update.sh --rollback      restore the newest archived binary and restart
#   scripts/update.sh --rollback TS   restore a specific archived binary (mesh-TS)
#   scripts/update.sh --list          list archived binaries (newest first)
#
# Deploy runs a pre-build GATE (bunx tsc --noEmit && bun test); if it fails, nothing is
# built or touched. The default install target is the normal user command directory
# (~/.local/bin/mesh), so a shell with ~/.local/bin on PATH can call `mesh` directly. The
# old binary is archived (timestamped) before the swap so a rollback can always go back.
# If the new binary is not healthy after restart, the script STOPS and reports (it does
# NOT auto-roll back) — run `scripts/update.sh --rollback` to restore the previous binary.
#
# Restarting is safe: running mesh daemons survive and the new backend reattaches to them
# (hot restart). Pass --cold to also reap the daemons (full restart) — see `mesh restart`.
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  cat <<'EOF'
Usage:
  scripts/update.sh [--cold]              build + deploy the latest source, restart service
  scripts/update.sh --rollback [TS] [--cold]   restore newest (or TS) archived binary, restart
  scripts/update.sh --list                list archived binaries (newest first)
  scripts/update.sh --help

Environment:
  MESH_WORK_ROOT     base dir to update (default: ~); data lives in <base>/.agent-mesh
  MESH_WORK_PORT     backend port to restart (default: 10010)
  MESH_BIN_DIR       local command dir (default: $XDG_BIN_HOME or ~/.local/bin)
  MESH_BIN           live binary path (default: $MESH_BIN_DIR/mesh)
  MESH_BACKUP_DIR    archive dir for old binaries (default: $XDG_STATE_HOME/mesh/backups or ~/.local/state/mesh/backups)
  MESH_BACKUP_KEEP   how many archived binaries to keep (default: 5)
  MESH_UPDATE_GATE   run tsc + bun test before building (default: 1; 0 to skip)

Advanced/test hooks:
  MESH_INSTALL_CMD   lockfile-backed dependency install run before gate/build (default: bun install --frozen-lockfile; set empty to skip)
  MESH_BUILD_CMD     build command; must write the new binary to "$OUT" (default: bun run scripts/build.ts)
  MESH_RESTART_CMD   launcher whose `restart` subcommand is invoked (default: $MESH_BIN)
  MESH_HEALTH_TIMEOUT  seconds to wait for /api/state after restart (default: 25)
  MESH_NOW           archive timestamp override (default: date +%Y%m%d-%H%M%S)
EOF
}

expand_path() {
  local p="$1"
  case "$p" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${p#"~/"}" ;;
    /*) printf '%s\n' "$p" ;;
    *) printf '%s/%s\n' "$PWD" "$p" ;;
  esac
}

path_contains_dir() {
  local needle="$1"
  local entry expanded
  local -a entries
  IFS=: read -ra entries <<<"${PATH:-}"
  for entry in "${entries[@]}"; do
    [[ -n "$entry" ]] || entry="."
    expanded="$(expand_path "$entry")"
    [[ "$expanded" == "$needle" ]] && return 0
  done
  return 1
}

# ── config ──────────────────────────────────────────────────────────────────────
PORT="${MESH_WORK_PORT:-10010}"
BASE_RAW="${MESH_WORK_ROOT:-$HOME}"
BIN_DIR_RAW="${MESH_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"
BIN_DIR="$(expand_path "$BIN_DIR_RAW")"
BIN="$(expand_path "${MESH_BIN:-$BIN_DIR/mesh}")"
BIN_DIR="$(dirname "$BIN")"
BACKUP_DIR="$(expand_path "${MESH_BACKUP_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/mesh/backups}")"
KEEP="${MESH_BACKUP_KEEP:-5}"
GATE="${MESH_UPDATE_GATE:-1}"
GATE_CMD="${MESH_GATE_CMD:-bunx tsc --noEmit && bun test}"
# Programmatic build (scripts/build.ts) so the Tailwind v4 plugin runs during
# --compile — the bun build CLI ignores bunfig [serve.static].plugins, which would
# otherwise ship the web client's `@import "tailwindcss"` unprocessed in the binary.
BUILD_CMD="${MESH_BUILD_CMD:-bun run scripts/build.ts --outfile \$OUT}"
RESTART_CMD="${MESH_RESTART_CMD:-$BIN}"
HEALTH_TIMEOUT="${MESH_HEALTH_TIMEOUT:-25}"
BASE="$(expand_path "$BASE_RAW")"
OUT=""

cleanup() {
  if [[ -n "${OUT:-}" && -e "$OUT" ]]; then
    rm -f "$OUT"
  fi
}
trap cleanup EXIT

# ── arg parsing ─────────────────────────────────────────────────────────────────
MODE="deploy"
COLD=0
ROLLBACK_TS=""
while (($#)); do
  case "$1" in
    --rollback|rollback) MODE="rollback"; if [[ "${2:-}" && "${2:0:1}" != "-" ]]; then ROLLBACK_TS="$2"; shift; fi ;;
    --list|list) MODE="list" ;;
    --cold) COLD=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# ── helpers ─────────────────────────────────────────────────────────────────────
# Archived binaries are named mesh-<timestamp>; the timestamp sorts lexically =
# chronologically, so `sort -r` is newest-first.
list_backups() {
  shopt -s nullglob
  local files=("$BACKUP_DIR"/mesh-*)
  ((${#files[@]})) || return 0
  printf '%s\n' "${files[@]}" | grep -v '\.build-id$' | sort -r || true
}

wait_healthy() {
  local end=$((SECONDS + HEALTH_TIMEOUT))
  local code
  while ((SECONDS < end)); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/state" 2>/dev/null || true)"
    if [[ "$code" =~ ^[1-4][0-9][0-9]$ ]]; then return 0; fi
    sleep 0.25
  done
  return 1
}

report_installed() {
  local action="$1"
  echo "$action → $BIN"
  if [[ "${BIN##*/}" == "mesh" ]]; then
    if path_contains_dir "$BIN_DIR"; then
      echo "mesh is available on PATH as: mesh"
    else
      echo "warning: $BIN_DIR is not on PATH; add it before calling 'mesh' directly" >&2
    fi
  fi
}

do_restart() {
  local -a cmd
  # RESTART_CMD may be a multi-word launcher (e.g. "bun run src/main.ts"); split it.
  # shellcheck disable=SC2206
  cmd=(${RESTART_CMD} restart --root "$BASE" --port "$PORT")
  ((COLD)) && cmd+=(--cold)
  echo "restarting: ${cmd[*]}"
  "${cmd[@]}"
}

# Restart, then confirm health. On failure, STOP and report (no auto-rollback).
restart_and_verify() {
  local what="$1"
  do_restart
  echo "waiting for backend health on :$PORT (up to ${HEALTH_TIMEOUT}s) ..."
  if wait_healthy; then
    echo "✓ $what live and healthy → http://localhost:$PORT  (root $BASE/.agent-mesh)"
    return 0
  fi
  echo "✗ backend did NOT become healthy after $what — service may be down." >&2
  echo "  log: $BASE/.agent-mesh/backend.log" >&2
  echo "  roll back with: scripts/update.sh --rollback${COLD:+ --cold}" >&2
  return 1
}

prune_backups() {
  shopt -s nullglob
  local all=()
  while IFS= read -r f; do all+=("$f"); done < <(list_backups)
  ((${#all[@]} > KEEP)) || return 0
  # newest-first, delete everything past KEEP
  local sorted i
  sorted=()
  while IFS= read -r f; do sorted+=("$f"); done < <(printf '%s\n' "${all[@]}" | sort -r)
  for ((i = KEEP; i < ${#sorted[@]}; i++)); do
    echo "pruning old backup: ${sorted[i]##*/}"
    rm -f "${sorted[i]}"
    rm -f "${sorted[i]}.build-id"
  done
}

# ── list mode ───────────────────────────────────────────────────────────────────
if [[ "$MODE" == "list" ]]; then
  if backups="$(list_backups)" && [[ -n "$backups" ]]; then
    echo "archived binaries in $BACKUP_DIR (newest first):"
    while IFS= read -r f; do printf '  %s\n' "${f##*/}"; done <<<"$backups"
  else
    echo "no archived binaries in $BACKUP_DIR"
  fi
  exit 0
fi

# ── rollback mode ───────────────────────────────────────────────────────────────
if [[ "$MODE" == "rollback" ]]; then
  target=""
  if [[ -n "$ROLLBACK_TS" ]]; then
    target="$BACKUP_DIR/mesh-$ROLLBACK_TS"
    [[ -f "$target" ]] || { echo "no such backup: $target" >&2; echo "(see: scripts/update.sh --list)" >&2; exit 1; }
  else
    target="$(list_backups | head -1)"
    [[ -n "$target" ]] || { echo "no archived binary to roll back to (dir: $BACKUP_DIR)" >&2; exit 1; }
  fi
  echo "rolling back: installing ${target##*/} → $BIN"
  mkdir -p "$BIN_DIR"
  cp -f "$target" "$BIN"
  if [[ -f "$target.build-id" ]]; then
    cp -f "$target.build-id" "$BIN.build-id"
  else
    rm -f "$BIN.build-id"
  fi
  chmod +x "$BIN"
  report_installed "restored binary"
  restart_and_verify "rollback (${target##*/})"
  exit $?
fi

# ── deploy mode ─────────────────────────────────────────────────────────────────
# 0) Dependency bootstrap: install exactly per the committed lockfile so a fresh
# checkout that pulled new package.json/bun.lock (e.g. the Tailwind v4 build plugin
# added in Step-5 C1) builds deterministically. Frozen → fails loudly if the lock is
# out of sync instead of silently mutating it. Both the gate (tsc/test) and the
# build need node_modules, so this runs first and unconditionally.
INSTALL_CMD="${MESH_INSTALL_CMD-bun install --frozen-lockfile}"
if [[ -n "$INSTALL_CMD" ]]; then
  echo "── dependency install (lockfile-backed) ───────────────────"
  echo "▸ $INSTALL_CMD"
  bash -c "$INSTALL_CMD"
  echo "✓ dependencies installed"
fi

# 1) Pre-build gate: typecheck + unit tests. Abort before touching anything if red.
if ((GATE)); then
  echo "── pre-build gate ─────────────────────────────────────────"
  echo "▸ $GATE_CMD"
  bash -c "$GATE_CMD"
  echo "✓ gate passed"
fi

# 2) Build the new binary to a same-directory staging path so a failed build never
# disturbs the live command, and the final rename stays atomic.
OUT="$BIN.new"
mkdir -p "$BIN_DIR" "$BACKUP_DIR"
rm -f "$OUT"
echo "── building new binary → $OUT ───────────────────────────"
OUT="$OUT" bash -c "$BUILD_CMD"
[[ -s "$OUT" ]] || { echo "build did not produce a non-empty binary at $OUT" >&2; exit 1; }
chmod +x "$OUT"

# 3) Archive the current binary (timestamped), then atomically install the new one.
TS="${MESH_NOW:-$(date +%Y%m%d-%H%M%S)}"
BUILD_ID="${MESH_BUILD_ID:-$TS}"
if [[ -f "$BIN" ]]; then
  archive="$BACKUP_DIR/mesh-$TS"
  # guard against same-second collisions so an archive is never overwritten
  if [[ -e "$archive" ]]; then n=2; while [[ -e "$archive.$n" ]]; do n=$((n + 1)); done; archive="$archive.$n"; fi
  echo "archiving current binary → ${archive#./}"
  cp -p "$BIN" "$archive"
  if [[ -f "$BIN.build-id" ]]; then cp -p "$BIN.build-id" "$archive.build-id"; fi
fi
mv -f "$OUT" "$BIN"
printf '%s\n' "$BUILD_ID" > "$BIN.build-id"
chmod +x "$BIN"
report_installed "installed new binary"
prune_backups

# 4) Restart the service with the new binary and verify it is healthy.
restart_and_verify "new binary"
exit $?
