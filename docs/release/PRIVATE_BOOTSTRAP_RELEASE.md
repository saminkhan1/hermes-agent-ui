# Private Bootstrap Release

Use this path until there is a paid Apple Developer account. These artifacts are ad-hoc signed, not notarized, and intended for private validation only.

## Download Surface

Do not send testers GitHub Actions artifact links. Actions artifacts are an internal build gate, can expire, and are awkward for non-engineers.

Create a GitHub prerelease and attach the verified files from `dist/`. The customer-facing link to share is the release page:

```text
https://github.com/saminkhan1/agent-UI/releases/tag/<tag>
```

For a direct download link, use the release asset URL:

```text
https://github.com/saminkhan1/agent-UI/releases/download/<tag>/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.dmg
```

Use `agent-UI Standalone` as the default customer download. Use `agent-UI for Hermes` only for testers who already have local Hermes installed and want the connector app.

## Files To Upload

Upload these files:

```text
dist/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.dmg
dist/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.zip
dist/agent-UI-for-Hermes-1.0.0-mac-arm64-bootstrap.dmg
dist/agent-UI-for-Hermes-1.0.0-mac-arm64-bootstrap.zip
dist/release-manifest.json
```

Do not send `.blockmap`, `latest-mac.yml`, or `builder-debug.yml` to testers unless an auto-update channel is being tested.

## Final Local Release Build

Run this only after committing the release source. The final `release-manifest.json` must show `package.sourceDirty: false` and `package.gitSha` equal to the release commit.

```bash
rm -rf dist
npm run verify
npm run dist:mac
npm run release:verify
npm run smoke:gateway
npm run smoke:installed-release -- "/Applications/agent-UI Standalone.app"
AGENT_UI_CONNECTOR_GATEWAY_RESTART_APPROVED=1 npm run smoke:installed-release -- "/Applications/agent-UI for Hermes.app"
scripts/tart-clean-room-smoke.sh dist/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.dmg
scripts/tart-clean-room-smoke.sh dist/agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.zip
git diff --check
```

If the default local desktop gateway port is already occupied, choose a free port for `smoke:gateway`:

```bash
LOCAL_DESKTOP_PORT=<free-port> npm run smoke:gateway
```

## Create The GitHub Prerelease

Pick a beta tag, for example:

```bash
tag=v1.0.0-beta.1
```

Create the tag on the verified release commit:

```bash
git tag -a "$tag" -m "agent-UI bootstrap beta 1"
git push origin main "$tag"
```

Create a draft prerelease with the verified artifacts:

```bash
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

Inspect the draft in GitHub, then publish it. After publishing, share:

```text
https://github.com/saminkhan1/agent-UI/releases/tag/v1.0.0-beta.1
```

If the repository is private, testers need GitHub access to the repository. If that is too much friction, upload the same verified DMG and `release-manifest.json` to a private object-store or Drive link and keep the SHA-256 values identical to the manifest.

## Tester Copy

Send this short version to Standalone testers:

```text
Download agent-UI Standalone from:
<GitHub Release link>

Install:
1. Download agent-UI-Standalone-1.0.0-mac-arm64-bootstrap.dmg.
2. Open the DMG and drag agent-UI Standalone.app to Applications.
3. On first launch, macOS may block it because this private beta is not notarized yet. In Finder, right-click the app and choose Open, then confirm.
4. Start a task. If the app asks for model/provider setup, complete the Hermes auth/model flow.
5. For voice, grant microphone permission when macOS prompts.
```

Send this only to connector testers:

```text
Use agent-UI-for-Hermes-1.0.0-mac-arm64-bootstrap.dmg only if you already have local Hermes installed. The connector does not bundle Hermes.
```
