#!/usr/bin/env bash
# Safely restart the production "work" agent-mesh backend from the OS layer.
# Default mode restarts only the combined backend process; mesh-host daemons are
# left alive for backend reattach. --cold also reaps registry daemons.
set -euo pipefail

cd "$(dirname "$0")/.."

usage() {
  cat <<'EOF'
Usage: scripts/restart-work.sh [--cold] [--help]

Environment:
  MESH_WORK_ROOT    base dir to restart (default: ~); data lives in <base>/.agent-mesh
  MESH_WORK_PORT    backend port to restart (default: 10010)
  MESH_LAUNCH_CMD   executable/command to launch (default: ./dist/mesh)

Default mode sends TERM then KILL to the backend matching both PORT and the --root
BASE, then starts a detached backend. --cold also kills daemon PIDs registered in
<base>/.agent-mesh/run/*.json and removes their .json/.sock files before relaunch.
EOF
}

COLD=0
for arg in "$@"; do
  case "$arg" in
    --cold) COLD=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

PORT="${MESH_WORK_PORT:-10010}"
BASE_RAW="${MESH_WORK_ROOT:-$HOME}"   # base dir; passed as --root. Data → <base>/.agent-mesh
LAUNCH_CMD="${MESH_LAUNCH_CMD:-./dist/mesh}"

expand_root() {
  local p="$1"
  case "$p" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${p#"~/"}" ;;
    /*) printf '%s\n' "$p" ;;
    *) printf '%s/%s\n' "$PWD" "$p" ;;
  esac
}

# BASE is what we pass as --root (and match in the backend's cmdline); ROOT is the actual
# storage dir <base>/.agent-mesh where the registry, sockets and log live.
BASE="$(expand_root "$BASE_RAW")"
mkdir -p "$BASE"
BASE="$(cd "$BASE" && pwd -P)"
ROOT="$BASE/.agent-mesh"
mkdir -p "$ROOT/run"
LOG="$ROOT/backend.log"

pid_alive() {
  kill -0 "$1" 2>/dev/null
}

cmdline_tokens() {
  local pid="$1"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' '\n' <"/proc/$pid/cmdline"
}

pid_has_arg_value() {
  local pid="$1" flag="$2" want="$3"
  local prev="" tok
  while IFS= read -r tok; do
    if [[ "$prev" == "$flag" && "$tok" == "$want" ]]; then return 0; fi
    if [[ "$tok" == "$flag=$want" ]]; then return 0; fi
    prev="$tok"
  done < <(cmdline_tokens "$pid")
  return 1
}

pid_matches_backend() {
  local pid="$1"
  pid_alive "$pid" || return 1
  pid_has_arg_value "$pid" "--port" "$PORT" || return 1
  pid_has_arg_value "$pid" "--root" "$BASE" || return 1
}

unique_lines() {
  awk 'NF && !seen[$0]++'
}

port_pids() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null \
      | awk -v port=":$PORT" '$4 ~ port "$" { print }' \
      | sed -nE 's/.*pid=([0-9]+).*/\1/p' \
      | unique_lines
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | unique_lines
  else
    echo "need ss or lsof to identify listener on port $PORT" >&2
    return 1
  fi
}

root_pids() {
  local proc pid
  for proc in /proc/[0-9]*; do
    pid="${proc##*/}"
    if pid_matches_backend "$pid"; then printf '%s\n' "$pid"; fi
  done | unique_lines
}

find_backend_pid() {
  local -a by_port=() matches=() by_root=()
  mapfile -t by_port < <(port_pids)
  mapfile -t by_root < <(root_pids)

  for pid in "${by_port[@]}"; do
    if pid_matches_backend "$pid"; then matches+=("$pid"); fi
  done

  if ((${#matches[@]} == 0)); then
    if ((${#by_port[@]} > 0 || ${#by_root[@]} > 0)); then
      echo "refusing to stop: no process matched both port $PORT and root $BASE" >&2
      echo "port candidates: ${by_port[*]:-(none)}" >&2
      echo "root candidates: ${by_root[*]:-(none)}" >&2
      return 2
    fi
    return 1
  fi
  if ((${#matches[@]} != 1)); then
    echo "refusing to stop: ambiguous backend matches: ${matches[*]}" >&2
    return 2
  fi
  printf '%s\n' "${matches[0]}"
}

wait_gone() {
  local pid="$1" seconds="$2"
  local end=$((SECONDS + seconds))
  while pid_alive "$pid" && ((SECONDS < end)); do sleep 0.2; done
  ! pid_alive "$pid"
}

stop_pid() {
  local pid="$1" label="$2"
  if ! pid_alive "$pid"; then return 0; fi
  echo "stopping $label pid $pid with SIGTERM"
  kill -TERM "$pid" 2>/dev/null || true
  if wait_gone "$pid" 10; then return 0; fi
  echo "$label pid $pid did not exit after 10s; sending SIGKILL" >&2
  kill -KILL "$pid" 2>/dev/null || true
  wait_gone "$pid" 3 || true
}

# Extract a flat-JSON field without a runtime dependency. The registry records are
# simple ({"name":..,"pid":N,"socketPath":"..",..}), and `node` is NOT always on PATH
# (nvm shims aren't loaded in minimal/non-login shells), which used to make --cold
# silently skip the daemon kill. grep/sed are always available.
json_field() {
  local file="$1" field="$2"
  case "$field" in
    pid|proto)
      grep -oE "\"$field\"[[:space:]]*:[[:space:]]*[0-9]+" "$file" 2>/dev/null | grep -oE '[0-9]+$' | head -1 ;;
    *)
      sed -nE "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p" "$file" 2>/dev/null | head -1 ;;
  esac
}

reap_daemons() {
  local rec pid sock
  shopt -s nullglob
  for rec in "$ROOT"/run/*.json; do
    pid="$(json_field "$rec" pid)"
    sock="$(json_field "$rec" socketPath)"
    if [[ "$pid" =~ ^[0-9]+$ ]]; then stop_pid "$pid" "daemon"; fi
    rm -f "$rec"
    if [[ -n "${sock:-}" && "$sock" == "$ROOT"/run/* ]]; then rm -f "$sock"; fi
  done
}

start_backend() {
  : >"$LOG"
  echo "starting backend: $LAUNCH_CMD --port $PORT --root $BASE"
  # Defense-in-depth: never let the backend inherit a mesh-host's control env (MESH_SOCK/
  # MESH_CONFIG would make it re-exec as a mesh-host instead of the backend). `env -u`
  # strips them even if this script is run from a polluted environment (e.g. by an agent).
  MESH_LAUNCH_CMD="$LAUNCH_CMD" setsid bash -c 'exec env -u MESH_SOCK -u MESH_CONFIG -u MESH_HOST_SCRIPT -u MESH_LEASE_MS ${MESH_LAUNCH_CMD:-./dist/mesh} --port "$1" --root "$2"' _ "$PORT" "$BASE" >>"$LOG" 2>&1 &
  local pid="$!"
  disown "$pid" 2>/dev/null || true

  local end=$((SECONDS + 10))
  while ((SECONDS < end)); do
    if pid_matches_backend "$pid"; then
      if curl -fsS "http://localhost:$PORT/api/state" >/dev/null 2>&1; then
        echo "backend restarted: pid $pid"
        echo "url: http://localhost:$PORT"
        return 0
      fi
    fi
    sleep 0.25
  done
  echo "backend start did not become healthy; pid $pid, log: $LOG" >&2
  return 1
}

# Only a COLD restart reaps the daemon, and reaping a mesh from INSIDE it (an agent running
# this script) kills the agent + this very shell (the daemon's SIGTERM handler →
# ControlPlane.stop() → killTree of its agents) — so the script would die after stopping the
# backend but before restarting it ("10010 never comes back"). For --cold only, run the work
# in a DETACHED, init-owned worker (double-fork via `( setsid … & )`) so it leaves the
# agent's process tree and survives the reap. A HOT restart never reaps the daemon, so the
# caller survives and we stay synchronous (callers see the full output + safety checks).
if ((COLD)) && [[ "${_MESH_RESTART_WORKER:-}" != "1" ]]; then
  ( _MESH_RESTART_WORKER=1 setsid bash "$0" "$@" >>"$LOG" 2>&1 </dev/null & )
  echo "cold restart dispatched (detached worker) — progress in $LOG"
  exit 0
fi

old_pid=""
set +e
old_pid="$(find_backend_pid)"
find_rc=$?
set -e
case "$find_rc" in
  0) stop_pid "$old_pid" "backend" ;;
  1) echo "no existing backend matched port $PORT and root $BASE; starting a new one" ;;
  2) exit 1 ;;
  *) echo "unexpected backend lookup status: $find_rc" >&2; exit 1 ;;
esac

if ((COLD)); then
  reap_daemons
fi

start_backend
