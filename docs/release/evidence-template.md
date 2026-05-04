# Release Evidence

Use this template for each release candidate. Keep it next to the final artifact hashes and manual Ring 3 notes.

## Candidate

- App commit:
- Branches aligned:
- GitHub Actions run:
- Artifact directory:
- Release mode: bootstrap
- macOS target architecture:

## Artifacts

| Kind | File | SHA-256 | Size | Manifest failures |
| --- | --- | --- | --- | --- |
| DMG |  |  |  |  |
| Zip |  |  |  |  |

## Ring 0 - Local Fast Checks

- `npm test`:
- `npm run build`:
- `git diff --check`:
- Notes:

## Ring 1 - GitHub Actions Build Gate

- Workflow:
- Runner:
- Hermes release tag:
- Manifest path:
- Manifest `package.gitSha`:
- Manifest `package.sourceDirty`:
- Manifest `hermes.gitSha`:
- Manifest `hermes.python.version`:
- Manifest `hermes.python.voiceRuntime.ok`:
- Manifest `environment.releaseMode`:
- Manifest artifact `failures`:
- Expected bootstrap trust-policy records:

## Ring 2 - Tart Clean-Room VM Gate

- Image:
- DMG smoke:
- Zip smoke:
- Bundled Hermes version output:
- Poisoned `PATH` / fake Jarvis result:
- Gateway `127.0.0.1:8766` result:

## Installed-App Automation

- Command: `npm run smoke:installed-release -- /Applications/agent-UI.app`
- Evidence directory:
- Background mode:
- Follow-up:
- Cancel:
- Conversation window:
- Port conflict:
- Quit/reopen:

## Ring 3 - Manual Customer Pass

- Tester:
- Machine:
- macOS version:
- CPU architecture:
- DMG mount in Finder:
- Drag to `/Applications`:
- Finder launch:
- Gatekeeper result:
- Right-click Open needed:
- Tray/menu:
- Text prompt:
- Follow-up:
- Cancel:
- `/background ...`:
- Voice TCC prompt:
- Microphone denied path:
- Microphone granted path:
- Transcript review/edit/submit:
- Quit/reopen:
- Missing credentials message:
- Offline first-run message:
- Port conflict message:

## Decision

- Ship / hold:
- Blocking gaps:
- Follow-up issues:
