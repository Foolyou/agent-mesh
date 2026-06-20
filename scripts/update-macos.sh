#!/usr/bin/env bash
# macOS entrypoint for the user-local mesh updater.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "warning: scripts/update-macos.sh is intended for macOS; delegating to scripts/update.sh anyway" >&2
fi

exec scripts/update.sh "$@"
