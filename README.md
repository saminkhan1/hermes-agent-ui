# agent-UI

agent-UI is a small macOS companion app for using a local Hermes runtime from
your desktop.

Press the global shortcut, type or speak a task, and agent-UI sends it to Hermes
with lightweight app/window/display context. Running sessions appear as desktop
pets with details, follow-up, cancel, and reopen support.

## What You Get

- Global text input from `Cmd+Shift+C`.
- Voice input that records through Hermes, shows the transcript for review, and
  submits only after you confirm.
- Desktop overlay for active Hermes sessions.
- Conversation details with follow-up and cancel.
- Background task support for first-message slash commands such as
  `/background ...`.
- A thin Hermes setup/login handoff when provider or model configuration is
  missing.

agent-UI is connector-only. It does not bundle Hermes, store provider
credentials, or copy tools into your Hermes tree. It uses your existing local
Hermes install and exposes only the packaged `local_desktop` plugin to Hermes at
runtime.

## Requirements

To use the packaged app:

- macOS.
- A local Hermes runtime installed with the official Hermes installer.
- A Hermes model/provider login or API key configured through Hermes.
- Microphone permission if you use voice input.

For the current bootstrap beta, macOS may require Finder's right-click Open
approval on first launch because the app is ad-hoc signed and not notarized.

## Install

1. Download `agent-UI-for-Hermes-1.0.0-mac-arm64-bootstrap.dmg` from the GitHub
   Release page.
2. Mount the DMG.
3. Drag `agent-UI for Hermes.app` to `/Applications`.
4. Launch from Finder. If macOS blocks the bootstrap build, right-click the app
   and choose Open.

## Use The App

1. Start the app.
2. Choose `Use Text Input` or `Use Voice Input` from the app, tray, or pet
   context menu.
3. Press `Cmd+Shift+C`.
4. Enter a task, or speak and review the transcript.
5. Submit. Hermes owns the actual run; agent-UI shows status, output, follow-up,
   and cancel controls.

If Hermes has no provider/model configured, agent-UI preserves your task and
shows the Hermes setup/login path instead of a generic failure.

## Local Hermes Behavior

agent-UI uses the Hermes local desktop gateway. It does not spawn `hermes chat`
or keep a local copy of conversation history.

agent-UI reads the default local Hermes profile and resolves Hermes from the
official installer launcher locations. It may write the required Hermes
`config.yaml` and `.env` settings for the local desktop gateway. It passes the
packaged `local_desktop` plugin to Hermes through `HERMES_BUNDLED_PLUGINS`; it
does not install or copy plugins into the user's Hermes tree. If the preferred
gateway port is occupied by another process, agent-UI rotates to a free local
port and writes that port to
the user's active Hermes `.env`.

Gateway mode behavior:

- Uses the current `conversationId` as the stable Hermes `conversation_id`.
- Stores only the last SSE sequence in `~/.agent-ui/hermes-gateway.json` so
  missed gateway events can replay; conversation content stays with Hermes.
- Sends the first prompt with tagged context metadata.
- Sends first-message slash commands such as `/background ...` without the
  context wrapper so Hermes can dispatch them normally.
- Sends follow-ups as plain text while Hermes owns same-session busy behavior.
- Sends conversation-window cancel as `/stop` through the same Hermes gateway
  conversation.
- Reconnects SSE from the last recorded sequence; if the replay window expired,
  it reconnects live and adds a local sync-gap error item.

## Build From Source

Developer prerequisites:

- Node.js and pnpm.
- macOS for app packaging.
- A local Hermes Agent checkout for development and runtime verification.

Clone and install:

```bash
git clone https://github.com/saminkhan1/agent-UI.git agent-UI
cd agent-UI
pnpm install
```

Run from source:

```bash
pnpm run dev
```

Build and preview the production bundle:

```bash
pnpm run build
pnpm start
```

Build a downloadable macOS app:

From the repo root:

```bash
pnpm run dist:mac
```

`pnpm run dist:mac` emits the connector DMG + zip artifacts with an ad-hoc signed app, no Apple notarization, and no stapling. Without paid Developer ID signing and notarization, browser-downloaded DMGs can show Apple's malware-verification dialog, and right-click Open is not reliable enough as the primary customer path. The GitHub release refresh step also generates `dist/install-agent-ui-for-hermes.sh`, a checksum-verified installer script that downloads the zip, verifies its SHA-256, installs the app into `/Applications`, clears quarantine on that installed copy, verifies the code signature, and opens the app.

The future Developer ID path remains available when paid signing and notarization credentials exist:

```bash
pnpm run dist:mac:developer-id
pnpm run release:verify:developer-id
```

The bootstrap artifacts are written to `dist/`, for example:

```text
dist/agent-UI-for-Hermes-1.0.0-mac-arm64-bootstrap.dmg
dist/agent-UI-for-Hermes-1.0.0-mac-arm64-bootstrap.zip
dist/install-agent-ui-for-hermes.sh
dist/release-manifest.json
```

The packaging path builds the Electron main/preload/renderer output as `agent-UI for Hermes.app`, omits `build/hermes-runtime`, and records `v2026.4.30+` as the required local Hermes baseline.

`GET /health` is unauthenticated. `POST /messages` and `GET /events` require `Authorization: Bearer <LOCAL_DESKTOP_GATEWAY_KEY>`.

Useful gateway controls:

```bash
export AGENT_UI_HERMES_GATEWAY_URL=http://127.0.0.1:8766
export AGENT_UI_HERMES_GATEWAY_KEY="<gateway secret>"
export AGENT_UI_HERMES_GATEWAY_AUTOSTART=0
```

Packaged app startup resolves the official Hermes launcher locations:
`~/.local/bin/hermes` and `/usr/local/bin/hermes`. It does not depend on an
interactive shell `PATH`.

## Use As A Local CLI

After installing dependencies, link the package once:

```bash
pnpm link
```

Then launch it from any terminal:

```bash
agent-ui
```

If the built app is missing, run `pnpm run build` from the repo root.

## Manual Test Checklist

1. Mount the connector bootstrap DMG.
2. Drag the app to `/Applications`.
3. Launch from Finder, using right-click Open for the bootstrap Gatekeeper approval if macOS requires it.
4. Confirm the app starts without requiring a terminal.
5. In the app, tray, or pet context menu, choose `Use Text Input`.
6. Press `Cmd+Shift+C`.
7. Enter a short prompt and submit.
8. Confirm a session appears and streams Hermes output.
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

1. Ring 0, local fast checks: `pnpm run verify:source`. No VMs.
2. Ring 1, GitHub Actions build gate: `.github/workflows/mac-release.yml` runs on pinned `macos-15`, verifies Hermes contracts against a real Hermes checkout, builds connector bootstrap DMG + zip artifacts once, verifies manifests plus artifact hashes, and uploads artifacts. GitHub runners are only a build gate, not clean-install proof.
3. Ring 2, installed-app automation: install or extract the exact connector artifact, run the smoke against `/Applications/agent-UI for Hermes.app`, and preserve its evidence directory.
4. Ring 3, manual customer pass: use the release installer script as the primary customer path, confirm it installs to `/Applications` and opens without Apple's malware-verification dialog, then confirm TCC microphone prompts, tray/menu behavior, text/voice sessions, follow-up, cancel, background mode, quit/reopen, and clear first-run errors for missing credentials, offline mode, port conflicts, and denied permissions. Keep the DMG as a fallback artifact only; if testing it manually, expect Gatekeeper friction unless a Developer ID/notarized build is produced.

After installing a release candidate into `/Applications`, run the installed-app
automation before the human Ring 3 pass:

```bash
pnpm run verify:installed -- "/Applications/agent-UI for Hermes.app"
```

`verify:installed` is the basic installed-app smoke. The full release e2e path
is `verify:live:release`, which drives the packaged app through real Hermes and
LM Studio with first launch, voice submit, follow-up, cancel, reopen,
three-session concurrency, no-provider onboarding, required stage coverage, and
Hermes log blockers. Both write JSON evidence to
`/private/tmp/agent-ui-installed-release-smoke-*`.

After Ring 1 packaging, run:

```bash
pnpm run release:verify
```

This writes `dist/release-manifest.json` with app mode, app version, git SHA, app source dirty status, connector Hermes baseline, whether Hermes runtime is included, packaged `local_desktop` source-match status, signing identity, notarization status, and SHA-256 hashes for every DMG/zip artifact. In bootstrap signing mode, `notarizationStatus` is recorded as `not_applicable_bootstrap`; `spctl` and stapler results are still captured as evidence but are not required to pass.

The customer-facing download link should be the GitHub Release page, not a
GitHub Actions artifact link. For bootstrap beta releases, the release page
should lead with the generated installer script command instead of the DMG
drag-and-open path, because the script verifies hashes before clearing
quarantine while the browser-downloaded DMG can repeatedly hit Gatekeeper.
After all local and GitHub gates pass, refresh the GitHub Release assets from the verified manifest:

```bash
pnpm run release:github:refresh -- v1.0.0-beta.1
```

## Verify

```bash
pnpm run verify:source
pnpm run dist:mac
pnpm run release:verify
pnpm run verify:live:release -- "/Applications/agent-UI for Hermes.app"
pnpm run verify:interaction:lmstudio -- "/Applications/agent-UI for Hermes.app"
```

`verify:source` is the fast app-owned contract gate: Hermes contract drift, TypeScript, build output, packaging mode, gateway env, eval server auth, and installed-smoke wiring. It is not a fake user-flow pass.

`verify:interaction:lmstudio` is the narrow macOS user-flow gate. It requires Accessibility permission plus the direct NousResearch Hermes clone, launches the installed app with isolated config, uses the real menu/shortcut/paste/click/Enter path, sends an initial prompt plus follow-up through real Hermes and real LM Studio, and saves screenshots plus JSON evidence under `/private/tmp/agent-ui-interaction-lmstudio-*`. Eval mode is only used for observation, coordinates, trace evidence, and shutdown; no local adapter or synthetic gateway is allowed.

`verify:live:release` is the preferred release gate for the live installed-app path. It runs first-launch, deterministic voice transcript insertion, live voice-submit, follow-up, cancel, post-cancel, reopen, three-session concurrency, no-provider onboarding with an actionable setup state or auth handoff, required stage coverage, and Hermes log-blocker checks in one installed-app smoke run, after one LM Studio preflight.

The live gate is intentionally stricter than the stage report table alone: required customer stages cannot be missing, and unexpected Hermes `ERROR`/`WARNING` log lines fail the run instead of being buried in the evidence directory. Bootstrap artifacts remain ad-hoc signed, so a passing live gate must be paired with either the checksum-verified installer-script path or a Developer ID/notarized build; the DMG right-click Open flow is fallback documentation, not the primary customer install path.

`verify:live:lmstudio` and `verify:concurrency:3` remain targeted demo gates. They require LM Studio serving `google/gemma-4-26b-a4b` at `http://127.0.0.1:1234/v1`, loaded with at least 64K context and parallelism for three requests, then drive the installed app through real Hermes and real model responses.

The gateway client/runtime are part of the Electron main process bundle. `pnpm run verify:source` checks that the build emits:

```text
out/main/hermes-gateway-client.js
out/main/hermes-runtime.js
```
