# Autoresearch: agent-UI Human E2E

## Goal
Use pi-autoresearch to improve the Electron UI app `agent-UI`.

The app path is:
`/Users/saminkhan1/Documents/agent-UI`

The local pi-autoresearch checkout is:
`/Users/saminkhan1/Documents/agent-UI-autoresearch`

Reference upstream pi-autoresearch behavior from:
`https://github.com/davebcn87/pi-autoresearch`

Hermes CLI references, if needed:
- `https://hermes-agent.nousresearch.com/docs/`
- `https://hermes-agent.nousresearch.com/docs/reference/cli-commands`
- `https://hermes-agent.nousresearch.com/docs/reference/slash-commands`

## Source-Derived Operating Rules
From pi-autoresearch:
- Treat this repository as a domain-specific optimization target. pi-autoresearch supplies the loop; this file supplies the benchmark contract, scope, metrics, and known history.
- `autoresearch.md` is the living session document. Keep it current with what has been tried, what failed, what improved metrics, and what should be attempted next.
- `autoresearch.sh` is the benchmark command. It must emit machine-readable `METRIC name=value` lines and should return nonzero only for infrastructure failures that make the metric invalid.
- `autoresearch.checks.sh` is a backpressure gate. It should run correctness checks after a passing benchmark so improvements that break the app are not kept.
- `autoresearch.jsonl` is append-only experiment history owned by pi-autoresearch. Do not delete it unless intentionally starting over with `/autoresearch clear`.
- Prefer repeatable measurements. Because pi-autoresearch uses confidence/noise signals after multiple runs, improve the benchmark so repeated runs are comparable before optimizing marginal latency.
- `autoresearch.config.json` lives in the pi session cwd (`/Users/saminkhan1/Documents/agent-UI-autoresearch`) and keeps `workingDir` pointed at `/Users/saminkhan1/Documents/agent-UI`; with `workingDir` set, pi-autoresearch reads/writes `autoresearch.md`, `autoresearch.sh`, `autoresearch.checks.sh`, and `autoresearch.jsonl` in the app repo.

From Hermes docs:
- Use `hermes chat -q "<prompt>"` for one-shot non-interactive prompts when the UI needs the full chat transcript/tool activity.
- Use `--quiet` for programmatic runs where banner/spinner/tool preview noise would corrupt stdout parsing.
- Use `--source agent-ui` so sessions are tagged as coming from the UI integration.
- Use `--pass-session-id` so Hermes includes the session ID in the prompt context and the UI can correlate artifacts.
- Use `--max-turns <N>` as a UI-controlled guardrail around tool-calling iterations.
- Do not switch providers/models, install skills, mutate profiles, or change Hermes config from `agent-UI`; those are Hermes user/admin concerns, not UI responsibilities.
- Slash-command behavior that matters for UI testing: `/stop` kills running background processes, `/queue <prompt>` queues without interrupting the current turn, `/steer <prompt>` injects a mid-run note after the next tool call, `/goal <text>` creates persistent continuation state, `/status` reports session info, `/retry` and `/undo` alter turn history, and `/resume [name]` resumes a named session. Test only what the UI intentionally exposes or forwards; do not invent unsupported UI controls just because Hermes has a slash command.

## Objective
Optimize `agent-UI` as a real macOS Electron UI layer for Hermes. The benchmark must exercise the same path a real user takes: arrange visible apps, press `Cmd+Shift+C`, type or dictate into the modal, choose a folder, submit the run, watch Hermes output stream through the UI, inspect the conversation, send follow-ups where appropriate, cancel/dismiss/revert when available, and verify the resulting external app state.

There are two primary goals:

1. Verify the end-to-end user workflow.
   The test harness must confirm that each UI state displays correct data and exposes the right actions. This includes idle, modal open, submitted, running, streaming output, completed, failed, cancelled, conversation opened, follow-up submitted, dismissed, reverted, and cleanup states. A running session must be cancellable from the UI, and each state transition must be observable in trace artifacts and validated by an oracle.

2. Improve the Electron UI implementation.
   Improve latency, responsiveness, correctness, and concurrency handling around the Hermes CLI call. Focus on UI-layer behavior: shortcut-to-modal latency, modal focus reliability, submit-to-visible-run latency, first Hermes output-to-bubble latency, streaming smoothness, multiple concurrent runs, cancellation behavior, cleanup, and recovery from failed/slow Hermes processes.

Do not change Hermes, LLM behavior, agent orchestration, tool execution semantics, prompts used by Hermes beyond the UI wrapper context, or any non-UI agent logic. `agent-UI` is only the interface layer for Hermes agent input/output.

Expected pi-autoresearch init:
- name: `agent-ui-human-e2e`
- metric: `ui_composite_score`
- unit: `score`
- direction: `higher`
- command: `./autoresearch.sh`

## Metrics
- **Primary**: `ui_composite_score` (`score`, higher is better).
- **Workflow correctness**: `workflow_success_rate`, `oracle_pass_rate`, `state_transition_pass_rate`, `action_availability_pass_rate`, `cleanup_success_rate`.
- **Input paths**: `typed_success_rate`, `voice_success_rate`, `modal_focus_success_rate`, `folder_selection_success_rate`.
- **Latency**: `shortcut_to_modal_p95_ms`, `submit_to_cat_visible_p95_ms`, `first_output_to_bubble_p95_ms`, `terminal_to_visual_p95_ms`, `cancel_to_stopped_p95_ms`.
- **Concurrency**: `concurrent_run_success_rate`, `concurrent_stream_integrity_rate`, `per_run_artifact_isolation_rate`.

Composite score:
`100 * (0.30*oracle_pass_rate + 0.20*state_transition_pass_rate + 0.15*human_ui_reliability + 0.15*latency_score + 0.10*concurrent_run_success_rate + 0.10*cleanup_success_rate)`.

## How To Run
Run through pi-autoresearch from the pi session workspace:

```bash
cd /Users/saminkhan1/Documents/agent-UI-autoresearch
/skill:autoresearch-create
# init: name=agent-ui-human-e2e, metric=ui_composite_score, unit=score, direction=higher, command=./autoresearch.sh
run_experiment
log_experiment
```

`/Users/saminkhan1/Documents/agent-UI-autoresearch/autoresearch.config.json` sets `workingDir` to `/Users/saminkhan1/Documents/agent-UI`, so `run_experiment` executes `./autoresearch.sh` from the app root and appends `autoresearch.jsonl` there. Direct shell execution of `./autoresearch.sh` is only a manual diagnostic fallback; the canonical loop is `run_experiment` → `log_experiment`.

The script must build the app, launch `agent-UI` in eval mode, drive the real UI with macOS CGEvents, run realistic human workflows, and print `METRIC name=value` lines. Scenario/oracle failures should lower metrics but should not crash the benchmark. Infrastructure failures may exit nonzero.

Hermes is invoked as:
`hermes chat -q <prompt> --quiet --source agent-ui --pass-session-id --yolo --max-turns <N>`

Do not switch to `hermes -z` for the benchmark path. Hermes documents `-z` as useful when only final answer text is wanted, but this app must observe streaming behavior, tool activity, session IDs, stdout/stderr, and conversation artifacts. Keep `hermes chat -q` unless the app intentionally adds a separate final-answer-only mode.

The child environment includes:
- `HERMES_SESSION_SOURCE=agent-ui`
- `AGENT_UI_HERMES_BIN=<resolved Hermes binary or checkout>`
- `AGENT_UI_EVAL=1`
- `AGENT_UI_EVAL_DIR=.agent-ui-eval`
- `AGENT_UI_CONFIG_DIR=<isolated per-run config dir>`

Each run writes artifacts under:
`.agent-ui-eval/runs/<runId>/`

Each UI/Hermes run writes per-cat artifacts under:
`.agent-ui-eval/runs/<runId>/cats/<catId>/`

Required artifacts include:
- `input.json`
- `prompt.txt`
- `stdout.log`
- `stderr.log`
- `conversation.json`
- `hermes-session.json`
- `hermes-session-export.jsonl`
- `tool-events.jsonl`
- `screenshot-context.png` when context capture is available
- `oracle.json`

Use `AGENT_UI_E2E_SCENARIOS=name1,name2` to run a subset while debugging. Default autoresearch runs all scenarios.

## Required Test Coverage
- Real shortcut path: press `Cmd+Shift+C`; do not spawn directly through an eval-only API.
- Real modal path: type text or use the dictation button; do not bypass modal submission.
- Real folder selection or recent-folder selection.
- Real Hermes CLI process invocation; do not fake, stub, or replace Hermes.
- Hermes command construction includes `chat`, `-q`, `--quiet`, `--source agent-ui`, `--pass-session-id`, `--yolo`, and the configured `--max-turns`.
- Streaming output rendered into visible UI bubbles.
- Conversation window opens and shows the correct run-specific transcript.
- Follow-up input works after a run has produced output.
- Running sessions can be cancelled from the UI, and cancellation stops UI progress cleanly.
- If cancellation maps to a Hermes slash command, verify behavior against `/stop`; otherwise verify the UI terminates the child process, records cancellation, and does not leave orphaned work.
- If follow-up queuing/steering is exposed, verify behavior against Hermes `/queue` and `/steer` semantics rather than interrupting active tool work unexpectedly.
- Completed sessions can be dismissed.
- Local folder runs can be reverted only through the app’s supported UI path.
- Multiple concurrent runs keep UI state, logs, Hermes sessions, and artifacts isolated.
- Failure states are visible, actionable, and do not corrupt other running sessions.
- Cleanup removes disposable external app data and leaves no Mail/Notes/Reminders/Anki/Obsidian/GarageBand leftovers.

## Realistic User Inputs
Use prompts that match what real users will ask the UI to do. Prefer tasks involving visible app context and external app verification, including:
- Summarize a visible PDF into an unsent Mail draft and Reminders follow-ups.
- Convert visible Chrome/PDF study material into an Anki deck and Obsidian study plan.
- Turn a Mail request into a reply draft, Reminders timeline, and Obsidian note update.
- Clean up visible research notes and produce a review request draft.
- Run at least one long-running or slow-output scenario so cancellation can be tested while Hermes is active.
- Run at least one concurrent scenario with two or more active sessions.
- Run at least one follow-up scenario that starts from an existing conversation and verifies the UI preserves session-specific context.
- Run at least one slash-command-like user input scenario, such as asking for status or stopping, only if the app forwards slash commands to Hermes. If the app treats slash commands as plain text, the oracle should document that current behavior.

All prompts must remain disposable, deterministic enough for oracles, and safe for local macOS apps.

## Files In Scope
- `src/main/**`
- `src/preload/**`
- `src/renderer/**`
- `assets/cursor-plugin/**`
- `eval/human-e2e/**`
- `autoresearch.md`
- `autoresearch.sh`
- `autoresearch.checks.sh`
- `/Users/saminkhan1/Documents/agent-UI-autoresearch/autoresearch.config.json` (pi session config only; keep out of the app repo working tree)
- `.gitignore`
- `package.json`
- `package-lock.json`
- `electron.vite.config.mjs`

## Off Limits
- Do not use `/spawn`; the eval server intentionally exposes sensors and cleanup only.
- Do not fake Hermes, stub the CLI, or bypass the modal/shortcut path.
- Do not reintroduce alternate CLI fallback, cloud runtime branches, direct renderer spawn helpers, or clipboard-paste typed input.
- Do not change Hermes internals, LLM behavior, agent orchestration, tool semantics, or slash-command behavior.
- Do not call `hermes model`, `hermes profile`, `hermes update`, `hermes uninstall`, or any command that mutates the user's Hermes installation/configuration.
- Do not use `--ignore-user-config` or `--ignore-rules` in normal UI benchmarks unless the experiment is explicitly measuring isolated CI/repro behavior.
- Do not mutate real Notes folders, Reminders lists, Mail drafts, Anki profiles, Obsidian vaults, or GarageBand projects.
- Do not delete or ignore `autoresearch.jsonl`; pi-autoresearch owns it.
- Do not put benchmark runtime output outside `.agent-ui-eval/` or `runs/`.

## Constraints
- macOS only.
- Hermes is required. Default path: `~/Documents/jarvis/.aura/hermes-agent/.venv/bin/hermes`.
- Mail drafts must never be sent and must only use `example.invalid` recipients.
- Anki must run with isolated per-cat `ANKI_BASE` under `.agent-ui-eval/runs/<runId>/anki-base/<scenario>`.
- Voice workflows use deterministic transcript injection through the real mic button by default; real Apple Speech is validated separately with `npm run eval:voice-smoke`.
- All disposable data must be named `agent-UI E2E <runId>` and cleaned up.

## What Has Been Tried
- Initial implementation added eval sensors, trace events, isolated config, deterministic voice, front-app context capture, and a macOS human E2E harness.
- Lean trace pass removed direct eval spawning, alternate CLI fallback, cloud/runtime UI, clipboard paste typing, and redundant stream-bubble trace spam. It added per-modal context IDs plus per-cat Hermes artifacts for input, prompts, stdout/stderr, session JSON, tool events, conversations, and oracles.
- Concurrency audit made setup source-focused for every scenario, moved destructive cleanup to pre/post run only, added scenario-label app baselines for oracles, and made `ANKI_BASE` cat-scoped so concurrent Anki workflows do not share state.
- 2026-05-01 experiment: verified pi-autoresearch README usage (`autoresearch.md` durable brief, `autoresearch.sh` benchmark, append-only `autoresearch.jsonl` when present). Baseline full run from the shell timed out at 600s while Hermes was still active, so confidence was low. Scoped rerun with `AGENT_UI_E2E_SCENARIOS=chrome-pdf-to-anki-study-pack` passed with `ui_composite_score=85`, `workflow_success_rate=1`, `oracle_pass_rate=1`, `shortcut_to_modal_p95_ms=518`, `submit_to_cat_visible_p95_ms=660`, `first_output_to_bubble_p95_ms=123`, `cleanup_success_rate=1`.
- 2026-05-01 kept experiment: enforced the required Hermes argv by adding `--quiet` to `hermes chat -q <prompt> --quiet --source agent-ui --pass-session-id --yolo --max-turns <N>`, added renderer sprite-asset prewarm to reduce cold spawn jank, and throttled live stream conversation pushes/persists to avoid per-chunk UI/disk churn while preserving first output and final conversation artifacts. Scoped rerun still scored `ui_composite_score=85` (`shortcut_to_modal_p95_ms=522`, `submit_to_cat_visible_p95_ms=667`, `first_output_to_bubble_p95_ms=124`), so this is primarily a correctness/responsiveness/compliance win rather than a measured latency win.
- 2026-05-01 checks: `./autoresearch.checks.sh` passed after the kept experiment (`validate-trace` ok on 25 events, `no-leftovers` ok). A full `./autoresearch.sh` rerun was started afterward because the benchmark is noisy and long-running; inspect the latest `.agent-ui-eval/runs/<runId>/results.json` before treating full-suite confidence as established.

## Next Best Experiments
- Add explicit UI/eval coverage for running-session cancellation, conversation follow-up, and supported revert/dismiss paths. Current benchmark exercises dismiss and artifact cleanup, but cancellation/follow-up/revert are not yet first-class metric producers.
- Reduce `submit_to_cat_visible_p95_ms` by moving any non-visual work that still precedes `cat_spawn_rendered` behind the overlay spawn path, then re-run a 3+ sample scoped benchmark to separate real gains from macOS event noise.
- Investigate full-suite hangs/timeouts by grouping scenarios or shortening only eval prompts without changing the real Hermes CLI path. Keep realistic visible-app context and do not stub Hermes.
- 2026-05-01 user correction: quarantined contaminated/aborted runs out of `.agent-ui-eval/runs/` into `.agent-ui-eval/contaminated-runs/` so latest-run checks do not select them. Removed disposable Notes leftovers created by prior evals. Changed default benchmark mode to serial; concurrency/stress now requires `AGENT_UI_E2E_MODE=concurrent` so primary scoring is not polluted by six overlapping Hermes runs. Added timeout cancellation via eval `/cancel` so unfinished cats do not remain orphaned.
- 2026-05-01 prompt-boundary fix: removed hidden agent-UI run context, cat id, selected folder prose, pointer JSON, and disposable-label suffix from Hermes `-q` input. The app still records folder/pointer/screenshot metadata as artifacts/traces for UI verification, but Hermes receives exactly typed/dictated prompt text. Added validation that `input.json` prompt hash equals `userPrompt` hash on new runs.
- 2026-05-01 prompt realism pass: shortened the benchmark prompts/transcripts to read like a real user request instead of a lab instruction, and normalized visible prompt text comparison so whitespace differences do not fail the oracle.
- 2026-05-01 latency instrumentation: trace events now include monotonic `tRelMs` + `seq`; added modal window creation, modal DOM load, modal focus, pointer-context substeps, submit pointer wait, spawn handoff, artifact prep duration, and generated `latency-report.json`/`latency-report.md` per run.
- 2026-05-01 input simplification: reduced the typing fallback chain to keep the test closer to a real user path (`replace-text`/typed input first, no AppleScript keystroke fallback) and lowered per-scalar sleep in the Swift CGEvent injector.
- 2026-05-01 pi-autoresearch setup alignment: moved `autoresearch.config.json` to the pi session cwd (`/Users/saminkhan1/Documents/agent-UI-autoresearch`) with `workingDir=/Users/saminkhan1/Documents/agent-UI`, matching upstream behavior. The redundant repo-local config was preserved at `/Users/saminkhan1/Documents/agent-UI-autoresearch/setup-backups/autoresearch.config.json.from-agent-UI.bak`. Canonical execution is `run_experiment`/`log_experiment`; direct `./autoresearch.sh` is diagnostic only. Do not run another benchmark until Samin approves; next run should be a scoped serial run first, then full serial, then optional concurrency stress.
- 2026-05-02 UI refactor: replaced the old full-screen wandering-cat canvas with a Codex-style floating pet shell: compact translucent panel, mascot badge, scrollable tray rows, and direct row-click conversation entry. Each session still maps to one pet row, preserving the multiple-pets concurrency model while making the shell glanceable like Codex `/pet`.
- 2026-05-02 streaming responsiveness: send the first stream-bubble IPC immediately, then keep the 120ms throttle for subsequent chunks. Scoped serial run improved `ui_composite_score` to 88.45 and `first_output_to_bubble_p95_ms` to 0 while preserving workflow/oracle/cleanup success.
- 2026-05-02 Codex fidelity CSS pass: kept the full-screen transparent Electron host for shortcut/mouse stability, but restyled the renderer to visually match Codex `/pet` more closely: separate top-right mascot, no enclosing card around mascot, compact 276px notification tray, smaller row avatars, and transparent shell. Scoped serial score improved to 88.55.
