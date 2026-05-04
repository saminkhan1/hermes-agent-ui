# Developer Onboarding

This guide gets a new contributor from a fresh clone to a verified local development environment.

## What This App Is

agent-UI is a thin macOS desktop launcher and status surface for Hermes. It captures local desktop context, starts text or voice input, and sends work to Hermes through the bundled `local_desktop` gateway path.

The release app is expected to carry its own Hermes runtime. A customer install must not require Node, npm, `uv`, Homebrew, Xcode Command Line Tools, `/usr/bin/python3`, an existing Hermes install, or a local Jarvis checkout.

## Prerequisites

Required for normal development:

- macOS
- Git
- Node.js and npm

Required for packaging:

- `uv` for build-time Python dependency resolution
- a Hermes checkout or release source pinned to `v2026.4.30`

Required for Ring 2 VM verification:

- Apple Silicon Mac
- Tart
- enough disk space for a vanilla macOS VM image

Optional future public distribution path:

- Developer ID Application signing credentials
- Apple notarization credentials

The current bootstrap distribution path does not require a paid Apple Developer account.

## Clone And Install

```bash
git clone https://github.com/saminkhan1/agent-UI.git agent-UI
cd agent-UI
npm install
```

Run the fast health gate before editing:

```bash
npm run verify
```

Expected result: all tests pass and `npm run build` succeeds.

## Run From Source

Development mode:

```bash
npm run dev
```

Production build plus preview:

```bash
npm run build
npm start
```

If a previous Electron dev process is stuck:

```bash
node scripts/ensure-clean-dev.js
```

## Build A Bootstrap macOS Artifact

Default packaging command:

```bash
npm run dist:mac
```

This builds the bootstrap no-paid-plan release path:

- DMG
- zip
- ad-hoc signed app
- no notarization
- no stapling

Artifacts are written to `dist/`.

If your Hermes checkout is not at the default local path, set it explicitly:

```bash
HERMES_BUNDLE_SOURCE=/path/to/hermes-agent npm run dist:mac
```

After packaging:

```bash
npm run release:verify
```

This writes `dist/release-manifest.json` with app SHA, Hermes SHA, Python runtime details, signing mode, notarization mode, artifact hashes, and verification failures.

## Runtime State

Important local files:

- `~/.agent-ui/local-desktop-gateway.env`: agent-UI generated local gateway secret, host, and port.
- `~/.agent-ui/hermes-gateway.json`: last gateway sequence used for reconnect/replay.
- Hermes provider config/auth: owned by Hermes, not by agent-UI.

Useful development overrides:

```bash
export AGENT_UI_HERMES_HOME=~/.agent-ui/hermes-home
export AGENT_UI_HERMES_GATEWAY_URL=http://127.0.0.1:8766
export AGENT_UI_HERMES_GATEWAY_KEY="<gateway secret>"
export AGENT_UI_HERMES_GATEWAY_AUTOSTART=0
```

`AGENT_UI_HERMES_BIN` is a development escape hatch. Packaged app release behavior must resolve Hermes from:

```text
agent-UI.app/Contents/Resources/hermes-runtime/bin/hermes
```

## Gateway And Provider Auth

Keep these layers separate:

- Gateway transport: local loopback HTTP/SSE, `LOCAL_DESKTOP_GATEWAY_KEY`, host, and port.
- Hermes runtime: bundled Hermes executable and Python runtime.
- Provider auth: Hermes model/provider credentials.

Symptoms:

- `ECONNREFUSED 127.0.0.1:8766`: gateway process or port issue.
- `LOCAL_DESKTOP_GATEWAY_KEY not set`: gateway env issue.
- `No inference provider configured`: Hermes provider auth/config issue.

A healthy gateway does not prove provider auth is configured.

## Project Map

- `src/main/`: Electron main process, gateway client, Hermes runtime resolution, eval server.
- `src/preload/`: safe preload bridge.
- `src/renderer/`: modal, conversation, and desktop UI.
- `vendor/hermes-platforms/local_desktop/`: app-owned Hermes platform overlay.
- `scripts/`: packaging, release manifest, smoke tests, and cleanup helpers.
- `packaging/`: Electron builder and macOS entitlement files.
- `test/`: Node test suite.
- `docs/release/`: manual release pass and release evidence template.

## Next Reading

- [Contributing](../CONTRIBUTING.md)
- [Testing And Verification](TESTING_AND_VERIFICATION.md)
- [Manual Customer Pass](release/MANUAL_CUSTOMER_PASS.md)
