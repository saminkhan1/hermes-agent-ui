<p align="center">
  <img src="assets/repo-banner.png" alt="agent-UI" width="100%" />
</p>

Write code with your agent-UI, little pixel familiars on your desktop. One cat per run, prowling on top of every window, purring until the task lands, while occasionally fighting with eachother. Click a cat to read its conversation or to see its final message. Cmd+Shift+C to launch a new cat.

## Powered by Hermes

agent-UI is powered by Hermes rooted at the folder you pick. It requires a Hermes binary, checks the default Jarvis checkout at `~/Documents/jarvis`, and does not fall back to any other CLI.

Set `AGENT_UI_HERMES_BIN` to point at a specific Hermes wrapper, binary, or checkout.

## How to Run

### Requirements

- Node.js and npm
- Hermes CLI available as `hermes` on your `PATH`

If Hermes is installed somewhere else, point agent-UI at it before launching:

```bash
export AGENT_UI_HERMES_BIN=/path/to/hermes
```

If Hermes lives inside a Jarvis checkout, the checkout folder also works:

```bash
export AGENT_UI_HERMES_BIN=/path/to/jarvis
```

### Run from this repo

Install dependencies:

```bash
npm install
```

Start the app in development mode:

```bash
npm run dev
```

Build and run the production bundle:

```bash
npm run build
npm start
```

### Run without cloning

**Run once without installing** (downloads the repo, runs `prepare`, then launches):

```bash
SHELL_RC="$HOME/.bashrc" && [[ "$SHELL" == */zsh ]] && SHELL_RC="$HOME/.zshrc"; grep -q 'alias agent-ui=' "$SHELL_RC" 2>/dev/null || echo 'alias agent-ui="npx --prefer-online -y github:sanatshah/agent-UI"' >> "$SHELL_RC" && source "$SHELL_RC"
```

**Install globally** so `agent-ui` is on your `PATH`:

```bash
npm install -g github:sanatshah/agent-UI
agent-ui
```

## Usage

- **Launch**: `agent-ui` (or `npx github:sanatshah/agent-UI`).
- While the app is running, use **Cmd+Shift+C** (macOS) or **Ctrl+Shift+C** (Windows/Linux) to add a new agent-UI run.
- **Local runs**: choose a folder on disk. Finished local cats can revert changes back to the folder snapshot captured when the cat spawned.
