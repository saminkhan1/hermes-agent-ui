#!/usr/bin/env bash
set -euo pipefail

source_path="${1:-}"
if [[ -z "$source_path" ]]; then
  echo "usage: $0 dist/agent-UI-<version>-mac-<arch>.(dmg|zip)|/path/to/artifact-dir" >&2
  exit 2
fi

image="${TART_IMAGE:-ghcr.io/cirruslabs/macos-sequoia-vanilla:latest}"
case "$image" in
  *-vanilla:latest|*-vanilla) ;;
  *)
    echo "TART_IMAGE must be a Cirrus vanilla image, not base/xcode/runner: $image" >&2
    exit 2
    ;;
esac

if ! command -v tart >/dev/null 2>&1; then
  echo "tart is required to boot the GUI clean-room VM." >&2
  exit 2
fi

if [[ -d "$source_path" ]]; then
  artifact_dir="$(cd "$source_path" && pwd)"
elif [[ -f "$source_path" ]]; then
  artifact_dir="$(cd "$(dirname "$source_path")" && pwd)"
else
  echo "artifact path does not exist: $source_path" >&2
  exit 2
fi

vm="${TART_VM_NAME:-agent-ui-manual-$(date +%Y%m%d%H%M%S)}"
artifact_name="$(basename "$source_path")"
log_file="${TART_LOG_FILE:-/tmp/${vm}.log}"

echo "[agent-ui] cloning $image into $vm"
tart clone "$image" "$vm"

echo "[agent-ui] starting GUI VM"
nohup tart run --dir="agent-ui-artifacts:$artifact_dir:ro" "$vm" >"$log_file" 2>&1 &

for _ in {1..90}; do
  ip="$(tart ip "$vm" 2>/dev/null || true)"
  if [[ -n "$ip" ]]; then
    break
  fi
  sleep 2
done

ip="${ip:-}"
echo "[agent-ui] VM name: $vm"
if [[ -n "$ip" ]]; then
  echo "[agent-ui] VM IP: $ip"
else
  echo "[agent-ui] VM IP: unavailable yet"
fi
echo "[agent-ui] shared artifacts: /Volumes/My Shared Files/agent-ui-artifacts"
echo "[agent-ui] artifact source: $artifact_dir"
echo "[agent-ui] artifact file: $artifact_name"
echo "[agent-ui] log file: $log_file"
echo "[agent-ui] next steps:"
echo "  1. Open the Tart VM window."
echo "  2. In the VM, open Finder and browse /Volumes/My Shared Files/agent-ui-artifacts."
echo "  3. Install the DMG or zip into /Applications."
echo "  4. Launch /Applications/agent-UI Standalone.app from Finder and test manually."
