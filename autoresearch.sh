#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DEFAULT_HERMES="$HOME/Documents/jarvis/.aura/hermes-agent/.venv/bin/hermes"
REQUESTED_HERMES="${AGENT_UI_HERMES_BIN:-$DEFAULT_HERMES}"

resolve_hermes() {
  local requested="$1"
  if [[ -d "$requested" ]]; then
    local candidates=(
      "$requested/hermes"
      "$requested/.venv/bin/hermes"
      "$requested/.aura/hermes-agent/.venv/bin/hermes"
      "$requested/hermes-agent/.venv/bin/hermes"
    )
    local candidate
    for candidate in "${candidates[@]}"; do
      [[ -x "$candidate" ]] && printf '%s\n' "$candidate" && return 0
    done
    return 1
  fi
  if [[ "$requested" == */* ]]; then
    [[ -x "$requested" ]] && printf '%s\n' "$requested" && return 0
    return 1
  fi
  command -v "$requested" 2>/dev/null || return 1
}

if ! RESOLVED_HERMES="$(resolve_hermes "$REQUESTED_HERMES")"; then
  echo "[autoresearch] Hermes is required at AGENT_UI_HERMES_BIN=$REQUESTED_HERMES" >&2
  exit 2
fi

if [[ "$(basename "$RESOLVED_HERMES")" != "hermes" ]]; then
  echo "[autoresearch] AGENT_UI_HERMES_BIN must resolve to Hermes, got $RESOLVED_HERMES" >&2
  exit 2
fi
export AGENT_UI_HERMES_BIN="$RESOLVED_HERMES"

npm run build >/dev/null
node eval/human-e2e/run.js
