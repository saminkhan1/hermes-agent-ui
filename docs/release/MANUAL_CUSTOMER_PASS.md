# Manual Customer Pass

Use this Ring 3 checklist only on the exact DMG and zip artifacts that passed Ring 1 verification and Ring 2 Tart clean-room smoke.

For the full release gate sequence, see [Testing And Verification](../TESTING_AND_VERIFICATION.md).

## What This Test Proves

Manual Ring 3 proves the real customer path that automation cannot fully cover: Finder install, Gatekeeper approval, macOS TCC/microphone prompts, tray/menu behavior, voice capture on actual hardware, and user-readable error messages.

Run this after:

- GitHub Actions built the artifact.
- `release-manifest.json` matches the release commit and artifact hashes.
- Tart clean-room smoke passed for both DMG and zip.
- Installed-app automation passed or is ready to run after install.

## Before Starting

- Record the artifact path and SHA-256.
- Record tester name, Mac model, CPU architecture, and macOS version.
- Quit any running `agent-UI`.
- Remove or replace any old `/Applications/agent-UI.app`.
- Keep Terminal available for the installed-app automation, but launch the app itself from Finder.

## Install Path

1. Mount the DMG from Finder.
2. Drag `agent-UI.app` to `/Applications`.
3. Launch from Finder, not Terminal.
4. For bootstrap artifacts, use Finder's right-click Open approval if macOS blocks the first launch.
5. Record whether Gatekeeper required right-click Open. A clean double-click Gatekeeper pass is expected only for future Developer ID-notarized artifacts.
6. Quit and reopen from Finder.
7. Repeat with the zip artifact by unzipping and launching the extracted app.

After installing into `/Applications`, run:

```bash
npm run smoke:installed-release -- /Applications/agent-UI.app
```

Record the evidence directory printed by the command.

## Runtime Path

- Confirm the app starts without Homebrew, CLT, Node, npm, `uv`, `/usr/bin/python3`, existing Hermes, or Jarvis setup.
- Confirm `~/Documents/jarvis` and a poisoned shell `PATH` do not affect the app's bundled Hermes runtime.
- Confirm the local gateway starts on `127.0.0.1:8766` when the port is free.
- Confirm port conflict handling chooses the next local port and shows an actionable message/log.
- Confirm missing LLM credentials show a provider login/setup error instead of a generic failure.
- Confirm offline first run shows an actionable network/provider error.

## User Workflows

- Text prompt starts a Hermes session and streams output.
- Follow-up sends into the same conversation.
- Cancel stops the active session and leaves the UI usable.
- `/background ...` starts background mode without wrapping the slash command.
- Quit/reopen reconnects to the local gateway without stale startup errors.
- Tray/menu actions still work after quit/reopen.

## Voice And Permissions

- Voice mode triggers the macOS microphone/TCC prompt on first use.
- Denying microphone permission produces a recoverable, actionable error.
- Granting microphone permission records, transcribes, shows the transcript for review, and submits after edit.
- Speech/audio behavior does not require `/usr/bin/swift` or developer tools.

## Artifact Evidence

- Preserve `dist/release-manifest.json`.
- Preserve `codesign`, `spctl`, notarization, and `stapler validate` output for the tested artifact. For bootstrap artifacts, `spctl`/stapler rejection is expected evidence, not a release failure.
- Record the tester macOS version, CPU architecture, artifact filename, and artifact SHA-256.
