# agent-UI

agent-UI is a thin desktop launcher and status surface for Hermes.

It captures lightweight app/window/display context when the global shortcut fires, opens a minimal task input, sends the first tagged prompt to Hermes through the `local_desktop` gateway, then gets out of the way while the pet stack shows session status.

## Requirements

- Node.js and npm
- Hermes with the bundled `local_desktop` platform plugin enabled
- A shared gateway secret in `LOCAL_DESKTOP_GATEWAY_KEY`

The old Hermes CLI wrapper path is still available as an explicit fallback. By default, agent-UI uses the local desktop gateway instead of spawning `aura-hermes chat`.

## Hermes Gateway Setup

Configure Hermes with the top-level platform config:

```yaml
platforms:
  local_desktop:
    enabled: true
    extra:
      host: 127.0.0.1
      port: 8766
      user_id: local
      outbox_retention_days: 7
```

Set the gateway environment before starting Hermes:

```bash
export LOCAL_DESKTOP_GATEWAY_KEY="$(openssl rand -hex 32)"
export LOCAL_DESKTOP_ALLOWED_USERS=local
export LOCAL_DESKTOP_ALLOW_ALL_USERS=false
export LOCAL_DESKTOP_HOST=127.0.0.1
export LOCAL_DESKTOP_PORT=8766
```

Start Hermes Gateway in the foreground for local development:

```bash
hermes gateway
```

With the local checkout used by this repo, use:

```bash
/Users/saminkhan1/Documents/jarvis/script/aura-hermes gateway
```

`hermes gateway start` is for the background launchd/systemd service manager.

`GET /health` is unauthenticated. `POST /messages` and `GET /events` require `Authorization: Bearer <LOCAL_DESKTOP_GATEWAY_KEY>`.

## agent-UI Gateway Config

agent-UI reads the same gateway key by default:

```bash
export LOCAL_DESKTOP_GATEWAY_KEY="<same value used by Hermes>"
```

For local AURA development on this machine, the generated env file can be loaded before starting either process:

```bash
set -a
source ~/.agent-ui/local-desktop-gateway.env
set +a
```

You can override the desktop client side without changing Hermes:

```bash
export AGENT_UI_HERMES_GATEWAY_KEY="<gateway secret>"
export AGENT_UI_HERMES_GATEWAY_URL=http://127.0.0.1:8766
```

Transport modes:

```bash
export AGENT_UI_HERMES_TRANSPORT=gateway  # default; fail if gateway is unavailable
export AGENT_UI_HERMES_TRANSPORT=auto     # try gateway, then fall back to CLI
export AGENT_UI_HERMES_TRANSPORT=cli      # force aura-hermes chat spawning
```

Gateway mode behavior:

- Uses the current pet `catId` as the stable Hermes `conversation_id`.
- Stores conversation mappings and last SSE sequence in `~/.agent-ui/hermes-gateway.json`.
- Sends the first prompt with the existing tagged context metadata.
- Sends follow-ups as plain text while Hermes owns same-session busy behavior.
- Sends cancel/background commands through Hermes slash commands (`/stop`, `/background <prompt>`).
- Reconnects SSE from the last recorded sequence; if the replay window expired, it reconnects live and adds a local sync-gap error item.

## CLI Fallback

CLI mode shells out to Hermes through `aura-hermes chat` and keeps the old local busy-session behavior. It needs an executable wrapper at `/Users/saminkhan1/Documents/jarvis/script/aura-hermes`.

To use a different wrapper in `cli` or `auto` fallback mode:

```bash
export AGENT_UI_HERMES_BIN=/path/to/aura-hermes
```

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

If you are using gateway mode, start Hermes Gateway before launching agent-UI.

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

## Use

- Press `Cmd+Shift+C` on macOS or `Ctrl+Shift+C` elsewhere.
- Enter or dictate the task.
- Submit with `Enter` or the start button.
- Use the pet stack to open details, send follow-ups, or dismiss completed work.
- In gateway mode, follow-ups can be sent while Hermes is still running. In CLI mode, follow-ups stay disabled until the child process finishes and a Hermes session id is available.

## Verify

```bash
npm test
npm run build
```

The gateway client is part of the Electron main process bundle. `npm run build` should emit `out/main/hermes-gateway-client.js`.
