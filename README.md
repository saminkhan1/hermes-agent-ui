<p align="center">
  <img src="assets/repo-banner.png" alt="Cursor Cats" width="100%" />
</p>

# Cursor Cats

Your desktop is lonely. Fix it. **Cursor Cats** lets tiny pixel cats prowl across your screen while **Cursor Agents** do the actual work: one cat per agent, roaming on top of every window, purring quietly until their task is done. Click a cat, see what it's thinking. Spawn a new one, point it at a folder, give it a prompt, and watch it wander off to code. It's a frameless, transparent, click-through overlay that stays out of your way and keeps your agents adorable.

## Cursor Agent SDK

Every cat is backed by a Cursor Agent. Here's how each type plugs into the SDK:

- **New Cursor Cat (SDK-backed)**: spawning a cat from the modal creates a [`@cursor/february`](https://www.npmjs.com/package/@cursor/february) `Agent` via `Agent.create({ apiKey, model: { id: 'composer-2' }, local: { cwd: folder } })` rooted at the folder you pick. The prompt is sent with `agent.send(prompt)`, and the returned `Run`'s `run.stream()` is drained into a per-cat conversation log (user / assistant / thinking / tool_call / status events). `run.wait()` resolves the final status and result, which flips the cat into "in review". Follow-up messages reuse the same `Agent` instance with another `agent.send(text)` call. Requires `CURSOR_API_KEY`. See `src/main/agents.js`.
- **IDE session cat (hook-bridged)**: cats that mirror **interactive Agent Chat sessions** inside the Cursor IDE. User-level Cursor hooks under `~/.cursor/hooks.json` run `sessionStart` / `sessionEnd` scripts that POST to a loopback HTTP server in the app (auth + port via `~/.cursorcats/ipc.json`). A cat appears when a Cursor composer session starts and disappears when it ends, with no API key required since Cursor runs the agent. Clicking the cat activates the Cursor app. Install hooks once with **`cursorcats add-hooks`** (see below). Hook sources live in `assets/cursor-plugin/hooks/`; see `src/main/hook-server.js` and `src/main/ide-sessions.js`.

## Cursor Cats CLI

The published command is **`cursorcats`** (see `bin` in `package.json`). It starts Electron with the built main process from `out/main/index.js`. The first install runs **`prepare`**, which runs `electron-vite build`.

### Install

**Run once without installing** (downloads the repo, runs `prepare`, then launches):

```bash
npx github:fieldsphere/cursor-cats
```

**Install globally** so `cursorcats` is on your `PATH`:

```bash
npm install -g github:fieldsphere/cursor-cats
cursorcats
```

**From a local clone** (after `npm install`, which also builds via `prepare`):

```bash
npm install
npx cursorcats
# or
node bin/cursorcats.js
```

If you see *Missing built main process*, run `npm run build` in the package root (or reinstall so `prepare` can run).

### Usage

- **Launch**: `cursorcats` (or `npx github:fieldsphere/cursor-cats`).
- **IDE session cats (Cursor hooks)**: run **`cursorcats add-hooks`** once. It copies the hook scripts into `~/.cursor/hooks/cursorcats/` and merges `sessionStart` / `sessionEnd` entries into **`~/.cursor/hooks.json`** (existing hook entries are kept). Reload Cursor (**Developer: Reload Window**) afterward. Re-run after upgrading cursorcats so the copied scripts stay in sync.
- **Cursor API key** (for **New Cursor Cat** agent runs): set before starting:

```bash
export CURSOR_API_KEY=your_key
cursorcats
```

Without `CURSOR_API_KEY`, the app still runs; the CLI prints a warning and **New Cursor Cat** agents will not run.

The subcommand **`add-hooks`** is handled by the CLI itself (see `bin/cursorcats.js`). Any other extra arguments are passed through to Electron.

### Quit

- **Menu bar (macOS) / tray**: right-click the tray icon → **Quit** (if the tray image looks like a tiny placeholder, the menu still works).
- **Keyboard**: **Cmd+Q** (macOS) or **Ctrl+Q** (Windows/Linux).

On macOS the Dock icon is hidden; use the tray or the shortcut to exit.

## Setup (clone for development)

```bash
cd cursorcats
npm install
npm run dev
```

For a production build and local run:

```bash
npm run build
npm start
```

Or launch the built app without Vite preview (from the repo root):

```bash
npm run build
node bin/cursorcats.js
```
