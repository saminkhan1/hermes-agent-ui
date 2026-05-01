<p align="center">
  <img src="assets/repo-banner.png" alt="Cursor Cats" width="100%" />
</p>

Write code with your Cursor Cats, little pixel familiars on your desktop. One cat per run, prowling on top of every window, purring until the task lands, while occasionally fighting with eachother. Click a cat to read its conversation or to see its final message. Cmd+Shift+C to launch a new cat.

## Powered by a Local CLI

Cursor Cats are powered by a local agent CLI rooted at the folder you pick. It uses Hermes when available, checks the default Jarvis checkout at `~/Documents/jarvis`, and falls back to `codex exec` when Hermes is not installed but the Codex CLI is available.

Set `CURSORCATS_HERMES_BIN` to point at a specific Hermes wrapper or binary. You can also set it to `codex` to force the Codex CLI adapter.

## How to Run

### Requirements

- Node.js and npm
- Hermes CLI available as `hermes` on your `PATH`, or Codex CLI available as `codex`

If Hermes is installed somewhere else, point Cursor Cats at it before launching:

```bash
export CURSORCATS_HERMES_BIN=/path/to/hermes
```

If Hermes lives inside a Jarvis checkout, the checkout folder also works:

```bash
export CURSORCATS_HERMES_BIN=/path/to/jarvis
```

To force the Codex CLI adapter:

```bash
export CURSORCATS_HERMES_BIN=codex
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
SHELL_RC="$HOME/.bashrc" && [[ "$SHELL" == */zsh ]] && SHELL_RC="$HOME/.zshrc"; grep -q 'alias cursorcats=' "$SHELL_RC" 2>/dev/null || echo 'alias cursorcats="npx --prefer-online -y github:sanatshah/Cursor-Cats"' >> "$SHELL_RC" && source "$SHELL_RC"
```

**Install globally** so `cursorcats` is on your `PATH`:

```bash
npm install -g github:sanatshah/Cursor-Cats
cursorcats
```

## Usage

- **Launch**: `cursorcats` (or `npx github:sanatshah/Cursor-Cats`).
- While the app is running, use **Cmd+Shift+C** (macOS) or **Ctrl+Shift+C** (Windows/Linux) to add a new Cursor Cat.
- **Local runs**: choose a folder on disk. Finished local cats can revert changes back to the folder snapshot captured when the cat spawned.
