<p align="center">
  <img src="assets/repo-banner.png" alt="Cursor Cats" width="100%" />
</p>

**Code with Cursor Cats**, little pixel familiars on your desktop while Cursor Agents do the real work. One cat per run, prowling on top of every window, purring until the task lands, while occasionally fighting with eachother. Click a cat to read its conversation or to see its final message. CMD+Shift+S to launch a new cat.

## Powered by the Cursor SDK

Cursor Cats are powered by the Cursor SDK. Spawning a cat from the modal creates a [`@cursor/february`](https://www.npmjs.com/package/@cursor/february) `Agent` via `Agent.create({ apiKey, model: { id: 'composer-2' }, local: { cwd: folder } })` rooted at the folder you pick.

## Installation

**Run once without installing** (downloads the repo, runs `prepare`, then launches):

```bash
npx github:fieldsphere/cursor-cats
```

**Install globally** so `cursorcats` is on your `PATH`:

```bash
npm install -g github:fieldsphere/cursor-cats
cursorcats
```

While the app is running, use **Cmd+Shift+C** (macOS) or **Ctrl+Shift+C** (Windows/Linux) to add a new Cursor Cat.

## Usage

- **Add Cursor API key** to your env:

```bash
export CURSOR_API_KEY=your_key
cursorcats
```

- **Launch**: `cursorcats` (or `npx github:fieldsphere/cursor-cats`).
