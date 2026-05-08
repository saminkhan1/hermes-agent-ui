#!/usr/bin/env bash
set -euo pipefail

artifact="${1:-}"
if [[ -z "$artifact" || ! -f "$artifact" ]]; then
  echo "usage: $0 dist/agent-UI-<version>-mac-<arch>.(dmg|zip)" >&2
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
  echo "tart is required for Ring 2 clean-room verification." >&2
  exit 2
fi

vm="${TART_VM_NAME:-agent-ui-release-$(date +%Y%m%d%H%M%S)}"
artifact_name="$(basename "$artifact")"
artifact_dir="$(cd "$(dirname "$artifact")" && pwd)"
tart_ssh_user="${TART_SSH_USER:-admin}"
tart_ssh_password="${TART_SSH_PASSWORD:-admin}"
ssh_opts=(
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o ConnectTimeout=5
  -o NumberOfPasswordPrompts=1
  -o IdentitiesOnly=yes
  -o PreferredAuthentications=password
  -o PubkeyAuthentication=no
)
if command -v sshpass >/dev/null 2>&1; then
  ssh_cmd=(sshpass -p "$tart_ssh_password" ssh "${ssh_opts[@]}")
else
  ssh_cmd=(ssh "${ssh_opts[@]}")
fi
run_pid=""

cleanup() {
  set +e
  if [[ -n "$run_pid" ]]; then kill "$run_pid" >/dev/null 2>&1; fi
  tart stop "$vm" >/dev/null 2>&1
  tart delete "$vm" >/dev/null 2>&1
}
trap cleanup EXIT

tart clone "$image" "$vm"
tart run --no-graphics --dir="agent-ui-artifacts:$artifact_dir:ro" "$vm" >/tmp/"$vm".log 2>&1 &
run_pid="$!"

ip=""
ssh_ready=false
for _ in {1..90}; do
  ip="$(tart ip "$vm" 2>/dev/null || true)"
  if [[ -n "$ip" ]]; then
    if "${ssh_cmd[@]}" "$tart_ssh_user@$ip" "echo ready" >/dev/null 2>&1; then
      ssh_ready=true
      break
    fi
  fi
  sleep 2
done

if [[ -z "$ip" || "$ssh_ready" != true ]]; then
  echo "VM did not become reachable over SSH." >&2
  exit 1
fi

"${ssh_cmd[@]}" "$tart_ssh_user@$ip" "ARTIFACT_NAME='$artifact_name' bash -s" <<'REMOTE'
set -euo pipefail

artifact="$HOME/Downloads/$ARTIFACT_NAME"
artifact_source="/Volumes/My Shared Files/agent-ui-artifacts/$ARTIFACT_NAME"
install_root="$HOME/agent-ui-install"
rm -rf "$install_root"
mkdir -p "$install_root"
mkdir -p "$HOME/Downloads"

if command -v brew >/dev/null 2>&1; then
  echo "Ring 2 must use a vanilla image; Homebrew is present." >&2
  exit 31
fi

for _ in {1..40}; do
  if [[ -f "$artifact_source" ]]; then
    break
  fi
  sleep 0.5
done
if [[ ! -f "$artifact_source" ]]; then
  echo "Mounted release artifact not found: $artifact_source" >&2
  ls -la "/Volumes/My Shared Files" >&2 || true
  exit 30
fi
cp "$artifact_source" "$artifact"

case "$artifact" in
  *.dmg)
    mkdir -p "$install_root/mnt"
    hdiutil attach -nobrowse -readonly -mountpoint "$install_root/mnt" "$artifact"
    app_path="$(find "$install_root/mnt" -maxdepth 2 -name 'agent-UI Standalone.app' -type d | head -n 1)"
    if [[ -z "$app_path" ]]; then
      echo "agent-UI Standalone.app not found in DMG." >&2
      exit 32
    fi
    rm -rf "/Applications/agent-UI Standalone.app"
    cp -R "$app_path" /Applications/
    hdiutil detach "$install_root/mnt"
    ;;
  *.zip)
    ditto -x -k "$artifact" "$install_root/unzip"
    app_path="$(find "$install_root/unzip" -maxdepth 4 -name 'agent-UI Standalone.app' -type d | head -n 1)"
    if [[ -z "$app_path" ]]; then
      echo "agent-UI Standalone.app not found in zip." >&2
      exit 33
    fi
    rm -rf "/Applications/agent-UI Standalone.app"
    cp -R "$app_path" /Applications/
    ;;
  *)
    echo "Unsupported artifact: $artifact" >&2
    exit 34
    ;;
esac

runtime="/Applications/agent-UI Standalone.app/Contents/Resources/hermes-runtime/bin/hermes"
if [[ ! -x "$runtime" ]]; then
  echo "Bundled Hermes launcher missing: $runtime" >&2
  exit 35
fi

mkdir -p "$HOME/fakebin" "$HOME/Documents/hermes/hermes-agent/venv/bin"
printf '#!/bin/sh\necho fake PATH hermes >&2\nexit 86\n' > "$HOME/fakebin/hermes"
printf '#!/bin/sh\necho fake Documents Hermes >&2\nexit 88\n' > "$HOME/Documents/hermes/hermes-agent/venv/bin/hermes"
chmod +x "$HOME/fakebin/hermes" "$HOME/Documents/hermes/hermes-agent/venv/bin/hermes"

version_out="$(
  PATH="$HOME/fakebin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
  HERMES_HOME="$HOME/.poison-hermes" \
  "$runtime" version
)"
echo "$version_out"
echo "$version_out" | grep 'Hermes Agent v0.12.0 (2026.4.30)' >/dev/null
echo "$version_out" | grep '/Applications/agent-UI Standalone.app/Contents/Resources/hermes-runtime/hermes-agent' >/dev/null

gateway_home="$HOME/.agent-ui-clean-room/hermes-home"
rm -rf "$gateway_home"
mkdir -p "$gateway_home"
cat > "$gateway_home/config.yaml" <<'YAML'
platforms:
  local_desktop:
    enabled: true
YAML

LOCAL_DESKTOP_GATEWAY_KEY=clean-room-secret \
LOCAL_DESKTOP_ALLOWED_USERS=local \
LOCAL_DESKTOP_ALLOW_ALL_USERS=false \
LOCAL_DESKTOP_HOST=127.0.0.1 \
LOCAL_DESKTOP_PORT=8766 \
HERMES_HOME="$gateway_home" \
PATH="$HOME/fakebin:/usr/bin:/bin:/usr/sbin:/sbin" \
"$runtime" gateway run > "$HOME/agent-ui-gateway.log" 2>&1 &
gateway_pid="$!"
trap 'kill "$gateway_pid" >/dev/null 2>&1 || true' EXIT

for _ in {1..80}; do
  if curl -fsS http://127.0.0.1:8766/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -fsS http://127.0.0.1:8766/health >/dev/null
curl -sS \
  -H 'Authorization: Bearer clean-room-secret' \
  -H 'Content-Type: application/json' \
  -d '{}' \
  http://127.0.0.1:8766/messages | grep 'missing_conversation_id' >/dev/null

app="/Applications/agent-UI Standalone.app"
app_tree_hash() {
  find "$app" -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    shasum -a 256 "$file"
  done | shasum -a 256 | awk '{print $1}'
}
codesign --verify --deep --strict --verbose=2 "$app"
before_hash="$(app_tree_hash)"
open -a "/Applications/agent-UI Standalone.app"
sleep 5
pgrep -f '/Applications/agent-UI Standalone.app/Contents/MacOS/agent-UI Standalone' >/dev/null
osascript -e 'tell application "agent-UI Standalone" to quit' >/dev/null 2>&1 || true
sleep 1
codesign --verify --deep --strict --verbose=2 "$app"
after_hash="$(app_tree_hash)"
if [[ "$before_hash" != "$after_hash" ]]; then
  echo "Installed app bundle changed after launch." >&2
  exit 40
fi
REMOTE

echo "[agent-ui] Tart clean-room smoke passed on $image"
