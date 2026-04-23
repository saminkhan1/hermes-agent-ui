<p align="center">
  <img src="assets/repo-banner.png" alt="Cursor Cats" width="100%" />
</p>

**Vibecode with cats**, little pixel familiars on your desktop while **Cursor Agents** do the real work. One cat per run, prowling on top of every window, purring until the task lands, and occasionally fighting with eachother. Click a cat to read the thread; spawn another, pick a folder, drop a prompt, and let it pad off to code.

## Cursor Agent SDK

Cats on your desktop are enabled from Cursor SDK runs. Spawning a cat from the modal creates a [`@cursor/february`](https://www.npmjs.com/package/@cursor/february) `Agent` via `Agent.create({ apiKey, model: { id: 'composer-2' }, local: { cwd: folder } })` rooted at the folder you pick. The prompt is sent with `agent.send(prompt)`, and the returned `Run`'s `run.stream()` is drained into a per-cat conversation log (user / assistant / thinking / tool_call / status events). `run.wait()` resolves the final status and result, which flips the cat into "in review". Follow-up messages reuse the same `Agent` instance with another `agent.send(text)` call. Requires `CURSOR_API_KEY`. See `src/main/agents.js`.

## Running Cursor Cats

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
