# Agent Guide

This repo is `agent-UI`, a thin Electron desktop launcher and status surface for
Hermes. Treat the local checkout as the source of truth. When Hermes behavior or
contracts matter, verify against the local Hermes checkout at
`/Users/saminkhan1/Documents/hermes/hermes-agent` instead of relying on public
docs or generated copies.

## Product Contract

- agent-UI is the UI/gateway layer. Hermes is the agent runtime and owns model
  auth, provider config, tool orchestration, conversation content, and session
  finalization.
- The shipped app is connector-only: `agent-UI for Hermes`. Do not add a
  bundled-Hermes or two-app release path unless the product contract changes.
- The app talks to Hermes through the `local_desktop` gateway:
  - `GET /health` is unauthenticated.
  - `POST /messages` and `GET /events` use
    `Authorization: Bearer <LOCAL_DESKTOP_GATEWAY_KEY>`.
- The app does not spawn `hermes chat` for tasks and does not keep local
  conversation history. It posts prompts to `/messages`, streams `/events`, and
  leaves transcript/session ownership in Hermes.
- The app may remember the local Hermes binary path and write the required
  gateway env/config settings. It may expose the packaged `local_desktop`
  plugin through `HERMES_BUNDLED_PLUGINS`, but it must not install, copy, or
  mutate plugins in a user's Hermes tree.
- Keep first-run failures actionable. Missing provider/model setup should route
  through the thin Hermes auth/model flow or show a specific Hermes setup error,
  not a generic app failure.

## Repo Map

- `src/main/index.ts`: Electron app bootstrap, windows, menus, tray, shortcuts,
  and app-level orchestration.
- `src/main/agents.ts`: Hermes gateway conversation bridge, prompt/context
  framing, replay, follow-up, cancel, and conversation push state.
- `src/main/hermes-runtime.ts`: local Hermes discovery, gateway env setup,
  process readiness, restart handling, voice capture, and safe runtime PATH.
- `src/main/hermes-gateway-client.ts`: local gateway HTTP/SSE client and
  `~/.agent-ui` config paths.
- `src/main/hermes-release.ts`: connector runtime state and Hermes candidate
  discovery for packaged app startup.
- `src/shared/contracts.ts`: shared app/Hermes boundary types. Keep this aligned
  with the real Hermes source.
- `src/renderer/`: pet stack, task modal, conversation window, auth/model flow,
  styles, and renderer-only helpers.
- `vendor/hermes-platforms/local_desktop/`: checked local desktop plugin source
  used for packaging/parity checks; do not treat this as newer than the live
  Hermes checkout.
- `scripts/verify-hermes-contracts.cjs`: drift guard against Hermes contracts
  and stale bundled/vendor surfaces.
- `scripts/verify-source-contracts.js`: repo-owned public/release surface guard.
- `scripts/installed-app-release-smoke.js`: black-box installed-app smoke and
  LM Studio live verification driver.
- `scripts/interaction-lmstudio-smoke.js`: real macOS menu/shortcut/click
  installed-app user-flow check against real Hermes and LM Studio.
- `scripts/lmstudio-live-preflight.js`: required LM Studio model/server
  preflight used before live verification gates.
- `packaging/`: connector-only Electron Builder configs.

If you add a new Electron main-process helper that must exist in production,
also add it to `MAIN_ENTRIES` in `electron.vite.config.mjs`; otherwise it may
work in source and disappear from `out/main`.

## Commands

Install once:

```bash
npm install
```

Run from source:

```bash
npm run dev
```

Build and preview:

```bash
npm run build
npm start
```

Fast verification gate:

```bash
npm run verify
```

`npm run verify` currently routes to `npm run verify:source`, which runs Hermes
contract verification, TypeScript strict checking, production build, and source
contract checks.

Targeted gates:

```bash
npm run verify:hermes-contracts
npm run verify:source-contracts
npm run dist:mac
npm run release:verify
npm run release:github:refresh -- v1.0.0-beta.1
npm run verify:installed -- "/Applications/agent-UI for Hermes.app"
```

Real LM Studio gates require LM Studio serving `google/gemma-4-26b-a4b` on
`http://127.0.0.1:1234/v1` with 64K context. The interaction gate also requires
macOS Accessibility permission and the direct NousResearch Hermes clone:

```bash
npm run verify:live:release -- "/Applications/agent-UI for Hermes.app"
npm run verify:interaction:lmstudio -- "/Applications/agent-UI for Hermes.app"
npm run verify:live:lmstudio -- "/Applications/agent-UI for Hermes.app"
npm run verify:concurrency:3 -- "/Applications/agent-UI for Hermes.app"
```

## Verification Rules

- Before changing code, inspect the worktree with `git status --short`. This
  repo is often dirty; never revert unrelated user changes.
- For narrow code changes, run the smallest relevant check plus
  `npm run verify` when feasible.
- For release, packaging, signing, or app-mode changes, run `npm run dist:mac`
  and `npm run release:verify`; then use the installed-app smoke against the
  actual app path.
- For full live release proof, prefer `npm run verify:live:release` over
  separately running `verify:live:lmstudio` plus `verify:concurrency:3`. The
  targeted scripts stay available for narrower reruns.
- For Hermes boundary changes, run `npm run verify:hermes-contracts` and verify
  against `/Users/saminkhan1/Documents/hermes/hermes-agent`.
- For menu, shortcut, modal, paste, click, or follow-up/cancel user-flow
  changes, prefer `npm run verify:interaction:lmstudio -- "/Applications/agent-UI for Hermes.app"`
  when the local permissions/runtime are available.
- For user-flow confidence, prefer installed-app and live Hermes/model checks
  over mocks. Mocks are acceptable only as narrow unit scaffolding, not as proof
  that the customer path works.
- Do not count eval mode, local JS adapters, synthetic gateway events, or fake
  auth/replay prompts as production proof. They can support observation only;
  the proof path must drive the installed app through real Hermes and a real
  model when user-flow confidence is the goal.
- If `electron-vite preview` fails with an Electron install error, inspect or
  rebuild `node_modules/electron` before changing app logic.

## Implementation Rules

- Keep the app lean. Do not reintroduce standalone runtime bundling, plugin
  installation, legacy AURA wording, dashboard/debugger surfaces, or transcript
  storage unless explicitly requested.
- Preserve the direct input-mode contract: visible `Use Text Input` and
  `Use Voice Input` choices, plus the `Cmd+Shift+C` launcher path.
- Preserve app-wide selectable/copyable user-visible text where practical,
  especially errors, transcript output, and setup instructions.
- Keep TypeScript strict. Avoid widening shared contracts with `any`; if an
  internal mutable shape must stay loose, isolate it away from
  `src/shared/contracts.ts`.
- Prefer existing CommonJS runtime patterns in main-process files:
  `import type ...` for types and `require(...)` for runtime imports.
- Keep renderer UI dense and operational. This is a desktop utility surface, not
  a marketing page.
- Do not store provider credentials or gateway secrets in app-owned product
  config. The remembered Hermes binary path is non-secret config.
- When gateway restart is needed, report the exact restart command unless the
  code path has explicit restart approval.

## Release Shape

`npm run dist:mac` builds the connector bootstrap DMG/zip using ad-hoc signing.
The expected product name is `agent-UI for Hermes`, and release metadata should
record `hermesRuntimeIncluded: false` with Hermes baseline `v2026.4.30+`.

The future Developer ID path exists through:

```bash
npm run dist:mac:developer-id
npm run release:verify:developer-id
```

Do not mention removed surfaces such as `agent-UI Standalone`, `bundle:hermes`,
`HERMES_BUNDLE_SOURCE`, `npm test`, or `docs/RELEASE.md` in current public
surfaces unless the repo intentionally brings them back and updates the contract
checks in the same change.
