# agent-UI

agent-UI is a thin desktop launcher and status surface for Hermes.

It captures lightweight app/window/display context when the global shortcut fires, then starts the currently selected input mode: text mode opens a minimal task input, while voice mode records through Hermes voice capture and places the transcript in the same input for review before submission.

## Manual Testing Goal

For manual testers, ship a single macOS app bundle/zip that contains:

- the Electron UI gateway (`agent-UI.app`);
- Hermes Agent core pinned to `v2026.4.30` plus the app-owned `local_desktop` platform overlay under the app resources;
- a self-contained Python 3.11+ Hermes runtime with local desktop gateway, messaging, and voice dependencies already resolved;
- automatic local gateway secret creation in `~/.agent-ui/local-desktop-gateway.env`;
- automatic Hermes Gateway startup on first prompt;
- separate text and voice input modes, follow-ups, and transcript review before submission.

The packaged app should not require gateway setup after install. Model/provider login still belongs to Hermes; if the tester has not configured a Hermes provider yet, Hermes will surface that setup/login error through the conversation details.

## Requirements

For developers building the distributable:

- Node.js and npm
- macOS for the mac app build
- `uv` for build-time Python dependency resolution
- a Hermes Agent checkout at `v2026.4.30`; by default the build script uses `/Users/saminkhan1/Documents/jarvis/.aura/hermes-agent`

Developer ID Application signing credentials and Apple notarization credentials are optional for the future public distribution track. The default bootstrapped track does not require a paid Apple Developer plan.

For manual testers using the packaged app:

- macOS
- a Hermes model/provider login or API key configured through Hermes
- microphone permission for voice input mode

## Build A Downloadable macOS App

From the repo root:

```bash
npm install
npm run dist:mac
```

`npm run dist:mac` is the bootstrapped packaging command. It emits DMG + zip artifacts with an ad-hoc signed app, no Apple notarization, and no stapling. This is the no-paid-plan path for direct testers; macOS may require the tester to use Finder's right-click Open approval on first launch.

The future Developer ID path remains available when paid signing and notarization credentials exist:

```bash
npm run dist:mac:developer-id
npm run release:verify:developer-id
```

The bootstrap artifacts are written to `dist/`, for example:

```text
dist/agent-UI-1.0.0-mac-arm64-bootstrap.dmg
dist/agent-UI-1.0.0-mac-arm64-bootstrap.zip
dist/release-manifest.json
```

To bundle a different Hermes checkout:

```bash
HERMES_BUNDLE_SOURCE=/path/to/hermes-agent npm run dist:mac
```

`npm run dist:mac` performs three steps:

1. copies the exact pinned Hermes release into `build/hermes-runtime` without `.git`, source venvs, caches, sessions, or logs;
2. overlays the vendored app-owned `vendor/hermes-platforms/local_desktop` plugin into `plugins/platforms/local_desktop` and records its SHA-256 in the runtime manifest;
3. creates a bundled `build/hermes-runtime/python` runtime and preinstalls the lean `[voice,messaging]` dependencies needed by local desktop gateway and voice input;
4. builds the Electron main/preload/renderer output;
5. packages `agent-UI.app` with `build/hermes-runtime` as app resources;
6. ad-hoc signs the bootstrap app and emits DMG + zip artifacts. `dist:mac:developer-id` instead uses Developer ID signing, hardened runtime, notarization, and stapling checks.

The bundled Hermes launcher does not create user venvs, call `uv`, call `/usr/bin/python3`, or install packages at customer runtime. If the bundled runtime is missing or damaged, it exits with an explicit rebuild error.

## Runtime Gateway Behavior

agent-UI uses the Hermes local desktop gateway. It does not spawn `hermes chat` or keep a local copy of conversation history.

On app startup/use, agent-UI:

1. creates `~/.agent-ui/local-desktop-gateway.env` if needed;
2. enables `platforms.local_desktop` in the active Hermes `config.yaml`;
3. reads `LOCAL_DESKTOP_GATEWAY_KEY`, host, and port from that env file;
4. checks unauthenticated `GET /health` plus a side-effect-free authenticated `POST /messages` schema probe on the local gateway;
5. starts `hermes gateway run` if the gateway is not already running with agent-UI's key;
6. connects to `/events` and posts prompts to `/messages`.

If the default local port is occupied by another process or by a Hermes gateway using a different key, agent-UI automatically moves its bundled gateway to the next available loopback port and rewrites `~/.agent-ui/local-desktop-gateway.env`.

`GET /health` is unauthenticated. `POST /messages` and `GET /events` require `Authorization: Bearer <LOCAL_DESKTOP_GATEWAY_KEY>`.

Useful overrides:

```bash
export AGENT_UI_HERMES_HOME=~/.agent-ui/hermes-home
export AGENT_UI_HERMES_GATEWAY_URL=http://127.0.0.1:8766
export AGENT_UI_HERMES_GATEWAY_KEY="<gateway secret>"
export AGENT_UI_HERMES_GATEWAY_AUTOSTART=0
```

`AGENT_UI_HERMES_BIN` remains a developer escape hatch, but normal packaged app startup resolves the Hermes launcher from `agent-UI.app/Contents/Resources/hermes-runtime/bin/hermes`. It does not search `PATH`, Homebrew, an existing Hermes install, or `~/Documents/jarvis`.

Gateway mode behavior:

- Uses the current pet `catId` as the stable Hermes `conversation_id`.
- Stores only the last SSE sequence in `~/.agent-ui/hermes-gateway.json` so missed gateway events can replay; conversation content stays with Hermes.
- Sends the first prompt with the existing tagged context metadata.
- Sends first-message slash commands such as `/background ...` without the context wrapper so Hermes can dispatch them normally.
- Sends follow-ups as plain text while Hermes owns same-session busy behavior.
- Sends conversation-window cancel as `/stop` through the same Hermes gateway conversation.
- Reconnects SSE from the last recorded sequence; if the replay window expired, it reconnects live and adds a local sync-gap error item.

## Clone And Install

```bash
git clone https://github.com/saminkhan1/agent-UI.git agent-UI
cd agent-UI
npm install
```

## Run From Source

Use dev mode while working on the app:

```bash
npm run dev
```

Build and preview the production bundle:

```bash
npm run build
npm start
```

## Use As A Local CLI

After installing dependencies, link the package once:

```bash
npm link
```

Then launch it from any terminal:

```bash
agent-ui
```

If the built app is missing, run `npm run build` from the repo root.

## Manual Test Checklist

1. Mount `dist/agent-UI-*-bootstrap.dmg`.
2. Drag `agent-UI.app` to `/Applications`.
3. Launch from Finder, using right-click Open for the bootstrap Gatekeeper approval if macOS requires it.
4. Confirm the app starts without requiring a terminal.
5. In the app or tray menu, choose `Settings > Input Mode > Text`.
6. Press `Cmd+Shift+C`.
7. Enter a short prompt and submit.
8. Confirm a pet/session appears and streams Hermes output.
9. Open details, send a follow-up, then press Cancel and confirm Hermes stops the active run.
10. Start one `/background ...` task and confirm Hermes accepts it as a slash command.
11. In the app or tray menu, choose `Settings > Input Mode > Voice`.
12. Press `Cmd+Shift+C`, grant macOS microphone permission if prompted, and confirm the prompt window shows voice recording/transcribing state.
13. Confirm the transcribed prompt appears in the text box, edit it if needed, then submit it to start a new session.
14. Quit/reopen the app and confirm the selected input mode and gateway reconnect path do not show a startup error.

Known first-run cases to check:

- If Hermes has no provider configured, the conversation details should show the actionable Hermes setup/login error instead of a generic failure.
- If microphone permission is missing, the UI should show a recoverable voice error.

## Release Gates

Use the four-ring release workflow for user-downloadable macOS artifacts:

1. Ring 0, local fast checks: `npm test` and `npm run build`. No VMs.
2. Ring 1, GitHub Actions build gate: `.github/workflows/mac-release.yml` runs on pinned `macos-15`, checks out Hermes `v2026.4.30`, builds bootstrap DMG + zip artifacts, verifies the ad-hoc signed app plus artifact hashes, and uploads artifacts. GitHub runners are only a build gate, not clean-install proof.
3. Ring 2, Tart clean-room gate: run `scripts/tart-clean-room-smoke.sh dist/<artifact>` against a Cirrus `*-vanilla` image, for example `ghcr.io/cirruslabs/macos-sequoia-vanilla:latest`. The script refuses `base` images, installs the artifact into `/Applications`, poisons `PATH` and fake Jarvis locations, verifies the bundled Hermes runtime, starts the local gateway on `127.0.0.1:8766`, and launches the app.
4. Ring 3, manual customer pass: mount the DMG, drag to `/Applications`, launch from Finder, approve the bootstrap Gatekeeper prompt with right-click Open if needed, confirm TCC microphone prompts, tray/menu behavior, text/voice sessions, follow-up, cancel, background mode, quit/reopen, and clear first-run errors for missing credentials, offline mode, port conflicts, and denied permissions.

After Ring 1 packaging, run:

```bash
npm run release:verify
```

This writes `dist/release-manifest.json` with app version, git SHA, app source dirty status, Hermes release/tag/SHA, bundled Python version, signing identity, notarization status, and SHA-256 hashes for every DMG/zip artifact. In bootstrap mode, `notarizationStatus` is recorded as `not_applicable_bootstrap`; `spctl` and stapler results are still captured as evidence but are not required to pass.

## Verify

```bash
npm test
npm run build
npm run bundle:hermes
npm run dist:mac
npm run release:verify
```

The gateway client/runtime are part of the Electron main process bundle. `npm run build` should emit:

```text
out/main/hermes-gateway-client.js
out/main/hermes-runtime.js
```
