# agent-UI

agent-UI is a thin desktop launcher and status surface for Hermes.

It captures lightweight app/window/display context when the global shortcut fires, then starts the currently selected input mode: text mode opens a minimal task input, while voice mode records through Hermes voice capture and places the transcript in the same input for review before submission.

## Manual Testing Goal

For manual testers, ship a single macOS app bundle/zip that contains:

- the Electron UI gateway (`agent-UI.app`);
- Hermes Agent source/runtime bootstrap under the app resources;
- automatic local gateway secret creation in `~/.agent-ui/local-desktop-gateway.env`;
- automatic Hermes Gateway startup on first prompt;
- separate text and voice input modes, follow-ups, and transcript review before submission.

The first run may install Python dependencies into `~/.agent-ui/hermes-runtime-venv`. Model/provider login still belongs to Hermes; if the tester has not configured a Hermes provider yet, Hermes will surface that setup/login error through the conversation details.

## Requirements

For developers building the distributable:

- Node.js and npm
- macOS for the mac app build
- a Hermes Agent checkout to bundle; by default the build script uses `/Users/saminkhan1/Documents/jarvis/.aura/hermes-agent`

For manual testers using the packaged app:

- macOS
- network access for first-run Python dependency install if the bundled venv is not already present
- a Hermes model/provider login or API key configured through Hermes
- Hermes voice-mode system dependencies available on the Mac (`portaudio` for microphone input and `ffmpeg` for STT audio conversion)
- microphone permission for voice input mode

## Build A Downloadable macOS App

From the repo root:

```bash
npm install
npm run dist:mac
```

The distributable zip is written to `dist/`, for example:

```text
dist/agent-UI-1.0.0-mac-arm64.zip
```

To bundle a different Hermes checkout:

```bash
HERMES_BUNDLE_SOURCE=/path/to/hermes-agent npm run dist:mac
```

`npm run dist:mac` performs three steps:

1. copies Hermes into `build/hermes-runtime` without `.git`, venvs, caches, sessions, or logs;
2. builds the Electron main/preload/renderer output;
3. packages `agent-UI.app` with `build/hermes-runtime` as app resources.

## Runtime Gateway Behavior

agent-UI uses the Hermes local desktop gateway. It does not spawn `hermes chat` or keep a local copy of conversation history.

On app startup/use, agent-UI:

1. creates `~/.agent-ui/local-desktop-gateway.env` if needed;
2. enables `platforms.local_desktop` in the active Hermes `config.yaml`;
3. reads `LOCAL_DESKTOP_GATEWAY_KEY`, host, and port from that env file;
4. checks `GET /health` on the local gateway;
5. starts `hermes gateway run` if the gateway is not already running;
6. connects to `/events` and posts prompts to `/messages`.

`GET /health` is unauthenticated. `POST /messages` and `GET /events` require `Authorization: Bearer <LOCAL_DESKTOP_GATEWAY_KEY>`.

Useful overrides:

```bash
export AGENT_UI_HERMES_BIN=/path/to/hermes
export AGENT_UI_HERMES_HOME=~/.agent-ui/hermes-home
export AGENT_UI_HERMES_GATEWAY_URL=http://127.0.0.1:8766
export AGENT_UI_HERMES_GATEWAY_KEY="<gateway secret>"
export AGENT_UI_HERMES_GATEWAY_AUTOSTART=0
```

Gateway mode behavior:

- Uses the current pet `catId` as the stable Hermes `conversation_id`.
- Stores only the last SSE sequence in `~/.agent-ui/hermes-gateway.json` so missed gateway events can replay; conversation content stays with Hermes.
- Sends the first prompt with the existing tagged context metadata.
- Sends first-message slash commands such as `/background ...` without the context wrapper so Hermes can dispatch them normally.
- Sends follow-ups as plain text while Hermes owns same-session busy behavior.
- Reconnects SSE from the last recorded sequence; if the replay window expired, it reconnects live and adds a local sync-gap error item.

## Clone And Install

```bash
git clone https://github.com/saminkhan1/Cursor-Cats.git agent-UI
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

1. Open `dist/mac*/agent-UI.app` or unzip/open the packaged `dist/agent-UI-*.zip`.
2. Confirm the app starts without requiring a terminal.
3. In the app or tray menu, choose `Settings > Input Mode > Text`.
4. Press `Cmd+Shift+C`.
5. Enter a short prompt and submit.
6. Confirm a pet/session appears and streams Hermes output.
7. Open details and send a follow-up.
8. In the app or tray menu, choose `Settings > Input Mode > Voice`.
9. Press `Cmd+Shift+C`, grant macOS microphone permission if prompted, and confirm the prompt window shows voice recording/transcribing state.
10. Confirm the transcribed prompt appears in the text box, edit it if needed, then submit it to start a new session.
11. Quit/reopen the app and confirm the selected input mode and gateway reconnect path do not show a startup error.

Known first-run cases to check:

- If Hermes has no provider configured, the conversation details should show the actionable Hermes setup/login error instead of a generic failure.
- If microphone permission is missing, the UI should show a recoverable voice error.

## Verify

```bash
npm test
npm run build
npm run bundle:hermes
npm run dist:mac
```

The gateway client/runtime are part of the Electron main process bundle. `npm run build` should emit:

```text
out/main/hermes-gateway-client.js
out/main/hermes-runtime.js
```
