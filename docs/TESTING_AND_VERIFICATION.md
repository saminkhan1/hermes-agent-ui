# Testing And Verification

Use this guide to decide which checks to run before merging, pushing a release branch, or telling a tester that an artifact is ready.

## Quick Matrix

| Change type | Minimum checks |
| --- | --- |
| Docs only | `npm test`, `git diff --check` |
| Renderer/UI behavior | `npm test`, `npm run build`, manual UI smoke |
| Main process, IPC, gateway, runtime | `npm test`, `npm run build`, `npm run smoke:gateway` |
| Dependency/security change | `npm test`, `npm run build`, `npm ls --depth=0`, `npm audit --json` |
| Packaging/release change | Ring 0, Ring 1, Ring 2, installed-app smoke, Ring 3 |

## Ring 0 - Local Fast Checks

Run these on every non-trivial change:

```bash
npm test
npm run build
git diff --check
```

For dependency or Electron/security-sensitive changes:

```bash
npm ls --depth=0
npm audit --json
```

For gateway behavior:

```bash
npm run smoke:gateway
```

Pass means the local source checkout is internally healthy. It does not prove a clean customer install.

## Ring 1 - GitHub Actions Build Gate

The release workflow is:

```text
.github/workflows/mac-release.yml
```

It runs on pushes to `deployment` and manual dispatches. It builds connector and standalone bootstrap DMG and zip artifacts on `macos-15` from the configured Hermes source. Local standalone builds default to `/Users/saminkhan1/Documents/hermes/hermes-agent` and preserve local Hermes modifications; the release manifest records the source path, git SHA, dirty state, dirty file list, and bundled tree hash.

Manual dispatch:

```bash
gh api repos/saminkhan1/agent-UI/actions/workflows/mac-release.yml/dispatches \
  -X POST \
  -f ref=deployment
```

Watch a run:

```bash
gh run watch <run-id> --repo saminkhan1/agent-UI --exit-status
```

Download artifacts:

```bash
mkdir -p /private/tmp/agent-ui-gh-run-<run-id>
gh run download <run-id> \
  --repo saminkhan1/agent-UI \
  --dir /private/tmp/agent-ui-gh-run-<run-id>
```

Verify manifest and hashes:

```bash
node -e "const fs=require('fs'); const p='/private/tmp/agent-ui-gh-run-<run-id>/agent-ui-mac-bootstrap-deployment/release-manifest.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); console.log(JSON.stringify({gitSha:m.package.gitSha,sourceDirty:m.package.sourceDirty,appMode:m.environment.appMode,signingMode:m.environment.signingMode,artifacts:m.artifacts.map(a=>({name:a.name,appMode:a.appMode,hermesRuntimeIncluded:a.hermesRuntimeIncluded,sha256:a.sha256,failures:a.failures}))},null,2));"
shasum -a 256 /private/tmp/agent-ui-gh-run-<run-id>/agent-ui-mac-bootstrap-deployment/*.dmg /private/tmp/agent-ui-gh-run-<run-id>/agent-ui-mac-bootstrap-deployment/*.zip
```

GitHub Actions artifact links are internal verification links, not customer download links. For private beta distribution, attach the verified DMG/zip files and `release-manifest.json` to a GitHub prerelease as described in [Private Bootstrap Release](release/PRIVATE_BOOTSTRAP_RELEASE.md).

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

## Ring 2 - Tart Clean-Room VM Gate

Use this before manual customer testing. The VM gate proves the artifact does not depend on your development machine.

One-time prerequisite:

```bash
command -v tart
```

If Tart is missing, install it on the host machine:

```bash
brew install cirruslabs/cli/tart
```

Run both artifacts:

```bash
DMG=/private/tmp/agent-ui-gh-run-<run-id>/agent-ui-mac-bootstrap-deployment/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.dmg
ZIP=/private/tmp/agent-ui-gh-run-<run-id>/agent-ui-mac-bootstrap-deployment/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.zip

TART_IMAGE=ghcr.io/cirruslabs/macos-sequoia-vanilla:latest \
scripts/tart-clean-room-smoke.sh "$DMG"

TART_IMAGE=ghcr.io/cirruslabs/macos-sequoia-vanilla:latest \
scripts/tart-clean-room-smoke.sh "$ZIP"
```

Expected success:

```text
[agent-ui] Tart clean-room smoke passed on ghcr.io/cirruslabs/macos-sequoia-vanilla:latest
```

Use only Cirrus `*-vanilla` images. Do not use `base`, `xcode`, or `runner` images because they can hide dependency leaks.

The script verifies:

- no Homebrew in the VM image
- artifact installs into `/Applications`
- bundled Hermes launcher exists
- fake `PATH` Hermes is ignored
- fake local Documents Hermes checkout is ignored
- bundled Hermes reports the manifest provenance for the selected local source
- gateway starts on `127.0.0.1:8766`
- app launches from `/Applications`

Common failures:

| Failure | Meaning |
| --- | --- |
| `tart is required` | Install Tart on the host. |
| `TART_IMAGE must be a Cirrus vanilla image` | Use a `*-vanilla` image. |
| `Homebrew is present` | Wrong VM image; do not accept the result. |
| `Bundled Hermes launcher missing` | Packaging bug. |
| `missing_conversation_id` is not returned | Gateway contract or auth regression. |
| fake Hermes output appears | Artifact leaked to host/local dependencies. |

## Installed-App Automation

After installing or extracting the exact standalone release app, run:

```bash
npm run smoke:installed-release -- "/Applications/agent-UI Standalone.app"
```

You can also point it at an extracted app:

```bash
npm run smoke:installed-release -- "/private/tmp/some-release/agent-UI Standalone.app"
```

The smoke uses isolated state and drives:

- text input mode switch
- background command
- follow-up
- cancel
- conversation window open
- port conflict recovery
- quit/reopen

Expected success:

```text
[agent-ui] installed app release smoke passed: /private/tmp/agent-ui-installed-release-smoke-...
```

Preserve the evidence directory path in the release template.

## Ring 3 - Manual Customer Pass

Run this only after Ring 2 passes. Use:

- [Manual Customer Pass](release/MANUAL_CUSTOMER_PASS.md)
- [Release Evidence Template](release/evidence-template.md)

Manual Ring 3 proves what automation does not fully cover:

- Finder mount and drag-to-Applications flow
- Gatekeeper first-launch behavior
- macOS microphone/TCC prompts
- real tray/menu behavior
- real voice recording hardware path
- human-readable missing credential/offline/permission-denied messages

Bootstrap artifacts are ad-hoc signed and not notarized. Right-click Open may be required on first launch; record it as expected bootstrap evidence.

## Release Decision

Do not call a release candidate verified unless all of these are true:

- Ring 0 passed on the release commit.
- Ring 1 GitHub Actions passed on `deployment`.
- Manifest and local artifact hashes match.
- Ring 2 Tart smoke passed for DMG and zip.
- Installed-app automation passed on the exact release app.
- Ring 3 manual customer pass was completed and recorded.

Developer ID `spctl`, notarization, and stapler clean acceptance are expected only for the future paid Developer ID distribution path. They are not pass criteria for the current bootstrap release path.

After the release commit is created, rebuild the final artifacts from that clean commit before sharing links. The release manifest must show `package.sourceDirty: false` and `package.gitSha` equal to the commit that was tagged.
