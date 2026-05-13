# agent-UI

agent-UI is a thin desktop launcher and status surface for Hermes.

It captures lightweight app/window/display context when the global shortcut fires, then starts the currently selected input mode: text mode opens a minimal task input, while voice mode records through Hermes voice capture and places the transcript in the same input for review before submission.

## Product Shape

For manual testers, ship one macOS app with the launcher, voice, pet stack, detail, follow-up, cancel, and thin Hermes auth/model flow:

- `agent-UI for Hermes`: a small connector for users who already have a local Hermes runtime.

The app posts prompts to Hermes `local_desktop` `/messages` and reads `/events`. agent-UI does not store LLM/provider credentials, does not keep gateway keys in its own config, and does not run a provider-auth preflight. The user starts a task first; if Hermes reports provider/model setup is required, agent-UI opens the thin Hermes auth/model flow and preserves the pending task.

The package omits Hermes runtime resources and bundled tool copies. It includes only the Agent UI `local_desktop` platform plugin resource and exposes it to the Hermes gateway process without copying files into the user's Hermes tree. It resolves and remembers the local Hermes binary path as non-secret config, revalidates it on launch, and connects to the user's existing Hermes config through the `local_desktop` gateway.

## Requirements

For developers building the distributable:

- Node.js and npm
- macOS for the mac app build
- a local Hermes Agent checkout for development and runtime verification

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

`npm run dist:mac` emits the connector DMG + zip artifacts with an ad-hoc signed app, no Apple notarization, and no stapling. This is the no-paid-plan path for direct testers; macOS may require the tester to use Finder's right-click Open approval on first launch.

The future Developer ID path remains available when paid signing and notarization credentials exist:

```bash
npm run dist:mac:developer-id
npm run release:verify:developer-id
```

The bootstrap artifacts are written to `dist/`, for example:

```text
dist/agent-UI-for-Hermes-1.0.0-mac-arm64-bootstrap.dmg
dist/agent-UI-for-Hermes-1.0.0-mac-arm64-bootstrap.zip
dist/release-manifest.json
```

The packaging path builds the Electron main/preload/renderer output as `agent-UI for Hermes.app`, omits `build/hermes-runtime`, and records `v2026.4.30+` as the required local Hermes baseline.

## Runtime Gateway Behavior

agent-UI uses the Hermes local desktop gateway. It does not spawn `hermes chat` or keep a local copy of conversation history.

agent-UI reads the default local Hermes profile, remembers the detected Hermes binary path in `~/.agent-ui/connector-runtime.json`, and revalidates it on launch. It may write the required Hermes `config.yaml` and `.env` settings for the local desktop gateway. It passes the packaged `local_desktop` plugin to Hermes through `HERMES_BUNDLED_PLUGINS`; it does not install or copy plugins into the user's Hermes tree. If the preferred gateway port is occupied by another process, agent-UI rotates to a free local port and writes that port to the user's active Hermes `.env`.

`GET /health` is unauthenticated. `POST /messages` and `GET /events` require `Authorization: Bearer <LOCAL_DESKTOP_GATEWAY_KEY>`.

Useful overrides:

```bash
export AGENT_UI_HERMES_HOME=~/Documents/hermes/hermes-home
export AGENT_UI_HERMES_GATEWAY_URL=http://127.0.0.1:8766
export AGENT_UI_HERMES_GATEWAY_KEY="<gateway secret>"
export AGENT_UI_HERMES_GATEWAY_AUTOSTART=0
```

`AGENT_UI_HERMES_BIN` remains a developer escape hatch. Packaged app startup resolves the remembered or detected local Hermes binary and does not search shell `PATH`.

Gateway mode behavior:

- Uses the current pet `catId` as the stable Hermes `conversation_id`.
- Stores only the last SSE sequence in `~/.agent-ui/hermes-gateway.json` so missed gateway events can replay; conversation content stays with Hermes.
- Sends the first prompt with the existing tagged context metadata.
- Sends first-message slash commands such as `/background ...` without the context wrapper so Hermes can dispatch them normally.
- Sends follow-ups as plain text while Hermes owns same-session busy behavior.
- Sends conversation-window cancel as `/stop` through the same Hermes gateway conversation.
- Reconnects SSE from the last recorded sequence; if the replay window expired, it reconnects live and adds a local sync-gap error item.
- Leaves Hermes session finalization in Hermes core.

## Clone And Install

```bash
git clone https://github.com/saminkhan1/agent-UI.git agent-UI
cd agent-UI
npm install
npm run verify
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

1. Mount the connector bootstrap DMG.
2. Drag the app to `/Applications`.
3. Launch from Finder, using right-click Open for the bootstrap Gatekeeper approval if macOS requires it.
4. Confirm the app starts without requiring a terminal.
5. In the app, tray, or pet context menu, choose `Use Text Input`.
6. Press `Cmd+Shift+C`.
7. Enter a short prompt and submit.
8. Confirm a pet/session appears and streams Hermes output.
9. Open details, send a follow-up, then press Cancel and confirm Hermes stops the active run.
10. Start one `/background ...` task and confirm Hermes accepts it as a slash command.
11. In the app, tray, or pet context menu, choose `Use Voice Input`.
12. Press `Cmd+Shift+C`, grant macOS microphone permission if prompted, and confirm the prompt window shows voice recording/transcribing state.
13. Confirm the transcribed prompt appears in the text box, edit it if needed, then submit it to start a new session.
14. While the pet overlay is visible, share the active display from FaceTime, Zoom, and Discord, then confirm the share starts and the overlay remains visible in the shared display.
15. Quit/reopen the app and confirm the selected input mode and gateway reconnect path do not show a startup error.

Known first-run cases to check:

- If Hermes has no provider configured, the conversation details should show the actionable Hermes setup/login error instead of a generic failure.
- If microphone permission is missing, the UI should show a recoverable voice error.

## Release Gates

Use the four-ring release workflow for user-downloadable macOS artifacts:

1. Ring 0, local fast checks: `npm run verify:source`. No VMs.
2. Ring 1, GitHub Actions build gate: `.github/workflows/mac-release.yml` runs on pinned `macos-15`, verifies source contracts against a real Hermes checkout, builds connector bootstrap DMG + zip artifacts once, verifies manifests plus artifact hashes, and uploads artifacts. GitHub runners are only a build gate, not clean-install proof.
3. Ring 2, installed-app automation: install or extract the exact connector artifact, run the smoke against `/Applications/agent-UI for Hermes.app`, and preserve its evidence directory.
4. Ring 3, manual customer pass: mount the DMG, drag to `/Applications`, launch from Finder, approve the bootstrap Gatekeeper prompt with right-click Open if needed, confirm TCC microphone prompts, tray/menu behavior, text/voice sessions, follow-up, cancel, background mode, quit/reopen, and clear first-run errors for missing credentials, offline mode, port conflicts, and denied permissions.

After installing a release candidate into `/Applications`, run the installed-app automation before the human Ring 3 pass:

```bash
npm run verify:installed -- "/Applications/agent-UI for Hermes.app"
```

The smoke launches the installed app in eval mode with isolated config/Hermes home directories, blocks the default gateway port to exercise port-conflict recovery, drives background mode, follow-up, cancel, conversation-window, and quit/reopen checks, then writes JSON evidence to `/private/tmp/agent-ui-installed-release-smoke-*`.

After Ring 1 packaging, run:

```bash
npm run release:verify
```

This writes `dist/release-manifest.json` with app mode, app version, git SHA, app source dirty status, connector Hermes baseline, whether Hermes runtime is included, packaged `local_desktop` source-match status, signing identity, notarization status, and SHA-256 hashes for every DMG/zip artifact. In bootstrap signing mode, `notarizationStatus` is recorded as `not_applicable_bootstrap`; `spctl` and stapler results are still captured as evidence but are not required to pass.

The customer-facing download link should be the GitHub Release page, not a GitHub Actions artifact link.
After all local and GitHub gates pass, refresh the GitHub Release assets from the verified manifest:

```bash
npm run release:github:refresh -- v1.0.0-beta.1
```

## Verify

```bash
npm run verify:source
npm run dist:mac
npm run release:verify
npm run verify:live:release -- "/Applications/agent-UI for Hermes.app"
npm run verify:interaction:lmstudio -- "/Applications/agent-UI for Hermes.app"
```

`verify:source` is the fast app-owned contract gate: Hermes contract drift, TypeScript, build output, packaging mode, gateway env, eval server auth, and installed-smoke wiring. It is not a fake user-flow pass.

`verify:interaction:lmstudio` is the narrow macOS user-flow gate. It requires Accessibility permission plus the direct NousResearch Hermes clone, launches the installed app with isolated config, uses the real menu/shortcut/paste/click/Enter path, sends an initial prompt plus follow-up through real Hermes and real LM Studio, and saves screenshots plus JSON evidence under `/private/tmp/agent-ui-interaction-lmstudio-*`. Eval mode is only used for observation, coordinates, trace evidence, and shutdown; no local adapter or synthetic gateway is allowed.

`verify:live:release` is the preferred release gate for the live installed-app path. It runs the same first-launch, follow-up, cancel, post-cancel, reopen, and three-session concurrency checks in one installed-app smoke run, after one LM Studio preflight.

`verify:live:lmstudio` and `verify:concurrency:3` remain targeted demo gates. They require LM Studio serving `google/gemma-4-26b-a4b` at `http://127.0.0.1:1234/v1`, loaded with at least 64K context and parallelism for three requests, then drive the installed app through real Hermes and real model responses.

The gateway client/runtime are part of the Electron main process bundle. `npm run verify:source` checks that the build emits:

```text
out/main/hermes-gateway-client.js
out/main/hermes-runtime.js
```
