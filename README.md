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

## Use

- Press `Cmd+Shift+C` on macOS or `Ctrl+Shift+C` elsewhere.
- Enter or dictate the task.
- Submit with `Enter` or the start button.
- Use the pet stack to open details, dismiss completed work, or reply when a session is waiting for input.
