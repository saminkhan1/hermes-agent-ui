# Release Guide

This is the single release and verification guide for agent-UI. Keep routine development setup in `README.md` and `CONTRIBUTING.md`; keep release evidence here.

## Quick Matrix

| Change type | Minimum checks |
| --- | --- |
| Docs only | `npm test`, `git diff --check` |
| Renderer/UI behavior | `npm test`, `npm run build`, manual UI smoke |
| Main process, IPC, gateway, runtime | `npm test`, `npm run build`, `npm run smoke:gateway` |
| Dependency/security change | `npm test`, `npm run build`, `npm ls --depth=0`, `npm audit --json` |
| Packaging/release change | Ring 0, Ring 1, Ring 2, installed-app smoke, Ring 3 |

## Ring 0 - Local Fast Checks

Run these before merging non-trivial changes:

```bash
npm test
npm run build
git diff --check
```

For gateway behavior:

```bash
npm run smoke:gateway
```

For dependency or Electron/security-sensitive changes:

```bash
npm ls --depth=0
npm audit --json
```

## Ring 1 - GitHub Actions Build Gate

The release workflow is `.github/workflows/mac-release.yml`. It runs on `deployment` and manual dispatch, builds connector and standalone bootstrap DMG/zip artifacts on `macos-15`, and writes `release-manifest.json`.

Manual dispatch:

```bash
gh api repos/saminkhan1/agent-UI/actions/workflows/mac-release.yml/dispatches \
  -X POST \
  -f ref=deployment
```

Pass criteria:

- workflow conclusion is `success`
- manifest `package.gitSha` equals the release commit
- manifest `package.sourceDirty` is `false`
- manifest `environment.appMode` is `all`
- manifest `environment.signingMode` is `bootstrap`
- connector artifacts have `hermesRuntimeIncluded: false`
- standalone artifacts have `hermesRuntimeIncluded: true`
- every artifact has `failures: []`
- local SHA-256 output matches the manifest

GitHub Actions artifact links are internal verification links, not customer download links.

## Ring 2 - Tart Clean-Room VM Gate

Use this before manual customer testing. The VM gate proves the artifact does not depend on your development machine.

One-time prerequisite:

```bash
command -v tart
```

Run both standalone artifacts:

```bash
DMG=/private/tmp/agent-ui-gh-run-<run-id>/agent-ui-mac-bootstrap-deployment/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.dmg
ZIP=/private/tmp/agent-ui-gh-run-<run-id>/agent-ui-mac-bootstrap-deployment/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.zip

TART_IMAGE=ghcr.io/cirruslabs/macos-sequoia-vanilla:latest \
scripts/tart-clean-room-smoke.sh "$DMG"

TART_IMAGE=ghcr.io/cirruslabs/macos-sequoia-vanilla:latest \
scripts/tart-clean-room-smoke.sh "$ZIP"
```

Use only Cirrus `*-vanilla` images. Do not use `base`, `xcode`, or `runner` images because they can hide dependency leaks.

## Installed-App Automation

After installing or extracting the exact standalone release app, run:

```bash
npm run smoke:installed-release -- "/Applications/agent-UI Standalone.app"
```

The smoke uses isolated state and drives text input mode, background command, follow-up, cancel, conversation window open, port conflict recovery, quit/reopen, and stage timing report generation.

Preserve the evidence directory path printed by the command. For a five-run customer stage pass, combine generated eval traces with:

```bash
npm run report:stages -- /private/tmp/agent-ui-installed-release-smoke-*/eval --markdown
```

## Ring 3 - Manual Customer Pass

Run this only on the exact connector and standalone DMG/zip artifacts that passed the earlier gates.

Install path:

1. Mount the DMG from Finder.
2. Drag the tested app to `/Applications`.
3. Launch from Finder, not Terminal.
4. For bootstrap artifacts, use Finder's right-click Open approval if macOS blocks the first launch.
5. Record whether Gatekeeper required right-click Open. A clean double-click Gatekeeper pass is expected only for future Developer ID-notarized artifacts.
6. Quit and reopen from Finder.
7. Repeat with the zip artifact by unzipping and launching the extracted app.

Standalone runtime checks:

- starts without Homebrew, CLT, Node, npm, `uv`, `/usr/bin/python3`, existing Hermes, or a local Hermes checkout
- ignores poisoned shell `PATH` and `~/Documents/hermes`
- starts the local gateway on `127.0.0.1:8766` when the port is free
- handles port conflicts by choosing the next local port
- shows provider login/setup errors instead of generic failures when LLM credentials are missing

Connector runtime checks:

- contains no `Contents/Resources/hermes-runtime`
- detects, remembers, and revalidates the local Hermes binary
- returns to reconnect setup when the remembered Hermes path is invalid
- does not install or copy plugins into the user's Hermes tree
- shows the exact manual restart command when gateway restart needs user action

User workflows:

- text prompt starts a Hermes session and streams output
- follow-up sends into the same conversation
- cancel stops the active session and leaves the UI usable
- `/background ...` starts background mode without wrapping the slash command
- quit/reopen reconnects without stale startup errors
- tray/menu actions work after quit/reopen

Voice and permissions:

- voice mode triggers the macOS microphone/TCC prompt on first use
- denying microphone permission produces a recoverable error
- granting microphone permission records, transcribes, shows the transcript for review, and submits after edit
- speech/audio behavior does not require `/usr/bin/swift` or developer tools

Bootstrap artifacts are ad-hoc signed and not notarized. `spctl` and stapler rejection is expected evidence for bootstrap artifacts, not a release failure.

## Private Bootstrap Release

Use this path until there is a paid Apple Developer account. These artifacts are ad-hoc signed, not notarized, and intended for private validation only.

Upload the verified files from `dist/` to a GitHub prerelease:

```text
dist/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.dmg
dist/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.zip
dist/agent-UI-for-Hermes-1.0.0-mac-arm64-bootstrap.dmg
dist/agent-UI-for-Hermes-1.0.0-mac-arm64-bootstrap.zip
dist/release-manifest.json
```

Do not send `.blockmap`, `latest-mac.yml`, `builder-debug.yml`, or GitHub Actions artifact links to testers unless an auto-update channel is being tested.

Create a draft prerelease with the verified artifacts:

```bash
tag=v1.0.0-beta.1
git tag -a "$tag" -m "agent-UI bootstrap beta 1"
git push origin main "$tag"
gh release create "$tag" \
  --repo saminkhan1/agent-UI \
  --draft \
  --prerelease \
  --title "agent-UI Bootstrap Beta 1" \
  --notes "Private bootstrap beta. These macOS apps are ad-hoc signed and not notarized, so first launch may require Finder right-click Open. Use Standalone unless you already have local Hermes installed." \
  dist/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.dmg \
  dist/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.zip \
  dist/agent-UI-for-Hermes-1.0.0-mac-arm64-bootstrap.dmg \
  dist/agent-UI-for-Hermes-1.0.0-mac-arm64-bootstrap.zip \
  dist/release-manifest.json
```

## Release Evidence

Use this template for each release candidate.

Candidate:

- App commit:
- Branches aligned:
- GitHub Actions run:
- Artifact directory:
- App mode: connector / standalone / all
- Signing mode: bootstrap
- macOS target architecture:

Artifacts:

| Kind | File | SHA-256 | Size | Manifest failures |
| --- | --- | --- | --- | --- |
| DMG |  |  |  |  |
| Zip |  |  |  |  |

Gate evidence:

- Ring 0 - Local Fast Checks:
- Ring 1 - GitHub Actions Build Gate:
- Ring 2 - Tart Clean-Room VM Gate:
- Installed-App Automation:
- Ring 3 - Manual Customer Pass:

Decision:

- Ship / hold:
- Blocking gaps:
- Follow-up issues:
