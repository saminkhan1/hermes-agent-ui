<p align="center">
  <img src="assets/repo-banner.png" alt="Cursor Cats" width="100%" />
</p>

# Cursor Cats

Need to fire off a quick agent? Let a Cursor cat handle that for you. **Cursor Cats** lets tiny pixel cats prowl across your screen while **Cursor Agents** do the actual work: one cat per agent, roaming on top of every window, purring quietly until their task is done. Click a cat, see what it's thinking. Spawn a new one, point it at a folder, give it a prompt, and watch it wander off to code. It's a frameless, transparent, click-through overlay that stays out of your way and keeps your agents adorable.

## Cursor Agent SDK

Cats on your desktop are **New Cursor Cat (SDK-backed)** runs. Spawning a cat from the modal creates a [`@cursor/february`](https://www.npmjs.com/package/@cursor/february) `Agent` via `Agent.create({ apiKey, model: { id: 'composer-2' }, local: { cwd: folder } })` rooted at the folder you pick. The prompt is sent with `agent.send(prompt)`, and the returned `Run`'s `run.stream()` is drained into a per-cat conversation log (user / assistant / thinking / tool_call / status events). `run.wait()` resolves the final status and result, which flips the cat into "in review". Follow-up messages reuse the same `Agent` instance with another `agent.send(text)` call. Requires `CURSOR_API_KEY`. See `src/main/agents.js`.

## Cursor Cats CLI

The published command is **`cursorcats`** (see `bin` in `package.json`). It starts Electron with the built main process from `out/main/index.js`. Installing the package runs **`prepare`**, which runs `electron-vite build` (so `out/` exists before first launch).

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

While the app is running, use **Cmd+Shift+C** (macOS) or **Ctrl+Shift+C** (Windows/Linux) to add a new Cursor Cat.

### Usage

- **Launch**: `cursorcats` (or `npx github:fieldsphere/cursor-cats`).
- **Cursor API key** (for **New Cursor Cat** agent runs): set before starting:

```bash
export CURSOR_API_KEY=your_key
cursorcats
```

Without `CURSOR_API_KEY`, the app still runs; the CLI prints a warning and **New Cursor Cat** agents will not run.

### Quit

- **Tray**: right-click (or left-click, depending on the platform) the tray icon → **Quit**. On macOS the tray can also show live cat counts next to the icon; if the tray image looks like a tiny placeholder, the menu still works.
- **Keyboard**: **Cmd+Q** (macOS) or **Ctrl+Q** (Windows/Linux).

On macOS the Dock icon is hidden while the overlay is running; use the tray or the shortcut to exit. Most tray and shortcut behavior is tuned for macOS; Windows and Linux should still get the tray menu and **Ctrl+Q**, but details (e.g. menu bar title badges) may differ.

## Setup (clone for development)

```bash
cd cursorcats
npm install
npm run dev
```

After a build, **`npm start`** runs `electron-vite preview` (serves the built renderer for a local run):

```bash
npm run build
npm start
```

Or launch the built app without Vite preview (from the repo root):

```bash
npm run build
node bin/cursorcats.js
```
