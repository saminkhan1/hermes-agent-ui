# agent-UI

agent-UI is a thin desktop launcher and status surface for Hermes.

It captures lightweight app/window/display context when the global shortcut fires, opens a minimal task input, sends a tagged prompt to Hermes, then gets out of the way while the pet stack shows session status.

## Requirements

- Node.js and npm
- Hermes wrapper at `/Users/saminkhan1/Documents/jarvis/script/aura-hermes`

To use a different wrapper:

```bash
export AGENT_UI_HERMES_BIN=/path/to/aura-hermes
```

## Run

```bash
npm install
npm run dev
```

Build and preview:

```bash
npm run build
npm start
```

## Use

- Press `Cmd+Shift+C` on macOS or `Ctrl+Shift+C` elsewhere.
- Enter or dictate the task.
- Submit with `Enter` or the start button.
- Use the pet stack to open details, dismiss completed work, or reply when a session is waiting for input.
