# Repo Lean Audit

This repo already has a small runtime core. The main weight comes from packaging helpers, evaluation harnesses, and documentation assets.

## Core runtime

These files are required for the app to run:

- `src/main/index.js`
- `src/main/agents.js`
- `src/main/hook-server.js`
- `src/main/ide-sessions.js`
- `src/main/eval-trace.js`
- `src/preload/index.js`
- `src/renderer/src/renderer.js`
- `src/renderer/src/modal.js`
- `src/renderer/src/conversation.js`
- `src/renderer/src/styles.css`
- `src/renderer/src/modal.css`
- `src/renderer/src/conversation.css`
- `src/renderer/src/insert-newline-at-cursor.js`
- `assets/cats/*`
- `assets/icon.png`
- `assets/tray.png`
- `assets/tray@2x.png`

## Packaging and install helpers

These are useful, but they are not the app runtime:

- `electron.vite.config.mjs`
- `bin/agent-ui.js`
- `scripts/add-hooks.js`
- `scripts/generate-tray-png.js`
- `assets/cursor-plugin/*`

## Dev-only / support surface

These can stay in the repo, but they are the first things to question if the goal is a lean ship:

- `eval/`
- `autoresearch.sh`
- `autoresearch.checks.sh`
- `autoresearch.config.json`
- `autoresearch.md`
- `assets/repo-banner.png`
- `assets/agent-ui-banner.png`

## Lean-down priorities

1. Keep `src/main/index.js` as the app entrypoint, but split only if maintenance cost becomes real. It is large, but it is the actual product logic.
2. Move evaluation artifacts out of the default mental model of the repo. They are useful, but they are not part of the shipped app.
3. Remove duplicate imagery and stale brand assets if they are not referenced anywhere.
4. Keep `assets/cursor-plugin` only if Cursor hook installation is still a supported workflow.
5. Leave generated outputs (`out/`, `node_modules/`, local eval state) out of the repo and out of source control.

## What I would strip first

If the goal is a lean repository rather than a feature refactor, the cleanest first pass is:

- trim README content to the current install/run path only
- remove or quarantine `autoresearch*` and `eval/` from the primary docs flow
- delete unused banner art
- verify `package.json` only publishes the files that are needed for install and runtime

This audit is intentionally conservative. It documents the separation between shipped code and support code before any deletion pass.
