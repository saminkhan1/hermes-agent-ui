# Pet Stack Port Evidence

This evidence ledger is subordinate to `docs/lean-product-contract.md`. When Codex.app behavior conflicts with the lean contract, agent-UI intentionally follows the lean contract.

## Static Codex.app Evidence

Target: `/Applications/Codex.app`

Commands:

```bash
python3 /Users/saminkhan1/.codex/skills/reverse-engineer-macos-apps/scripts/ui_porting_inventory.py --format json --term avatar-overlay --term openAvatarOverlay --term codex-avatar --term Activity --term notification --term avatar-overlay-element-size-changed --term avatar-overlay-pointer-interaction-changed --term avatar-overlay-keyboard-interaction-changed --term avatar-overlay-drag-release --term needs-input --term Dismiss --term Reply --term Latest --term older --include-source-maps /Applications/Codex.app > /tmp/agent-ui-codex-avatar-deep-inventory.json
python3 /Users/saminkhan1/.codex/skills/reverse-engineer-macos-apps/scripts/macos_app_triage.py --format json --search avatar-overlay --search openAvatarOverlay --search codex-avatar --search avatar-overlay-drag-release /Applications/Codex.app > /tmp/agent-ui-codex-avatar-triage.json
```

Working set:

- `.vite/build/main-DlFGMsC6.js`
- `webview/assets/avatar-overlay-page-Dj9Zinq_.js`
- `webview/assets/codex-avatar-BpKnWN_W.js`
- `webview/assets/codex-avatar-D82knaKt.css`
- `webview/assets/use-floating-window-pointer-interactivity-BZT8RRB7.js`
- `webview/assets/avatar-overlay-open-state-signal-BGjzvfQc.js`
- `webview/assets/index-DJATSIwz.js`

## Port Decisions

- Stack persistence: Codex.app uses per-status expiry windows and dismissed turn keys in `avatar-overlay-page-Dj9Zinq_.js`. The lean contract forbids TTL hiding and temporary notification semantics, so agent-UI keeps submitted sessions visible until explicit terminal dismiss.
- Needs input: Codex.app derives waiting state from structured runtime flags and request-user-input records. The lean contract forbids prose parsing, so agent-UI only exposes inline reply when the session status is explicitly `needs-input`/`waiting`.
- Tray layout: Codex.app clamps the mascot with bottom padding but clamps the tray to the display edge without that bottom padding. agent-UI now mirrors that split to keep stack alignment stable.
- Default tray sizing: Codex.app lays out against a default `276x131` tray before renderer measurement. agent-UI now does the same to avoid first-render tray misalignment.
- Pointer hit testing: Codex.app reports renderer-side avatar/tray hit regions back to the main process with `avatar-overlay-pointer-interaction-changed`. agent-UI now mirrors that with `pet-pointer-interaction-changed`, using DOM `elementsFromPoint` over `[data-avatar-overlay-hit-region]` and `[data-avatar-mascot="true"]`. The older screen-rect polling remains only as a startup fallback before the renderer has reported exact pointer state.
- Avatar assets: Codex packaged sprites are inspect-only. agent-UI uses its local `assets/cats/cat.png` sprite and maps animation frame counts to the local manifest so status states do not enter blank frames.
- Follow-up resume: The lean contract requires Hermes resume semantics. agent-UI now refuses follow-up submission until a Hermes session id is available instead of silently starting a non-resumed turn.
- Eval artifacts: Each Hermes CLI call now writes a stable per-call artifact under `runs/run-###/` while preserving the existing latest `prompt.txt`/`stdout.log`/`stderr.log` paths. This keeps the initial context-tagged prompt inspectable after a resumed follow-up overwrites the latest prompt.

## Real Hermes Verification

Run id: `manual-real-hermes-codex-20260502-1604`

Observed user path:

- Finder was activated, then the normal global shortcut opened the launcher.
- Prompt submitted through the launcher: `Reply exactly: AGENT_UI_E2E_OK. Also name the active app from the provided context metadata.`
- Hermes command resolved to `/Users/saminkhan1/Documents/jarvis/script/aura-hermes`.
- The pet stack showed the submitted session, then the detail window was opened from the stack row.
- Detail follow-up submitted: `Reply exactly: AGENT_UI_FOLLOWUP_OK.`
- The same Hermes session resumed with `--resume 20260502_160542_4939e2`.

Evidence files:

- `.agent-ui-eval/runs/manual-real-hermes-codex-20260502-1604/cats/e4f0878b-0dd2-4e13-92c7-53bba7cdf600/runs/run-001/prompt.txt`
- `.agent-ui-eval/runs/manual-real-hermes-codex-20260502-1604/cats/e4f0878b-0dd2-4e13-92c7-53bba7cdf600/runs/run-002/input.json`
- `.agent-ui-eval/runs/manual-real-hermes-codex-20260502-1604/cats/e4f0878b-0dd2-4e13-92c7-53bba7cdf600/conversation.json`

Verified:

- `run-001/prompt.txt` contains `<user_message source="agent-ui">`, `<aura_meta type="context_snapshot" version="1">`, `context_quality`, `missing_context`, and the observational trust note.
- Hermes output included `AGENT_UI_E2E_OK. Active app: Unknown`; context was present but active-window fields were unavailable on this machine.
- `run-002/input.json` includes `--resume` with `20260502_160542_4939e2`.
- Detail output included `AGENT_UI_FOLLOWUP_OK.`
- The completed stack row remained visible after follow-up completion.

## Unverified Original Runtime Behavior

No Codex.app runtime launch, debugger attach, UI driving, screenshot capture, account data, app data, logs, or network inspection was used. Hover/focus pixel parity against the live Codex app remains unclaimed without explicit runtime approval.
