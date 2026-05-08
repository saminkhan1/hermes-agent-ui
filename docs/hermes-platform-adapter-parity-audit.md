# Hermes Platform Adapter Parity Audit

Audit target: https://hermes-agent.nousresearch.com/docs/developer-guide/adding-platform-adapters

Scope: Agent UI's vendored `local_desktop` Hermes platform adapter.

## Result

`local_desktop` follows the Hermes Plugin Path design. It is a Hermes platform
adapter, not an Agent UI orchestration path.

## Evidence

| Hermes adapter contract | Local implementation | Status |
| --- | --- | --- |
| Use the Plugin Path for third-party/community adapters | `vendor/hermes-platforms/local_desktop/plugin.yaml` plus `__init__.py` and `register(ctx)` | Pass |
| Implement a `BasePlatformAdapter` subclass | `LocalDesktopAdapter(BasePlatformAdapter)` | Pass |
| Implement `connect()` and mark connected after transport setup | Starts aiohttp loopback server, then calls `_mark_connected()` | Pass |
| Implement `disconnect()` and mark disconnected after cleanup | Cleans aiohttp runner, closes subscribers, calls `_mark_disconnected()` | Pass |
| Implement `send()` for outbound text delivery | Appends replayable `message.created` outbox events | Pass |
| Forward inbound messages via `handle_message(event)` | `/messages` builds `MessageEvent` with `build_source(...)`, then calls `handle_message` | Pass |
| Register through `ctx.register_platform(...)` | Registers `local_desktop` with `adapter_factory`, `check_fn`, `validate_config`, auth env names, message limits, PII flag, update flag, and `platform_hint` | Pass |
| Surface env vars in `plugin.yaml` | Uses rich `requires_env` and `optional_env` entries for Hermes config/setup UI | Pass |
| Support env-driven auto-configuration | Defines `_env_enablement()` and passes it as `env_enablement_fn` when the loaded Hermes runtime supports that PlatformEntry field | Pass, compatibility-gated |
| Support cron home-channel discovery | Passes `cron_deliver_env_var="LOCAL_DESKTOP_HOME_CHANNEL"` when the loaded Hermes runtime supports that PlatformEntry field | Pass, compatibility-gated |
| Avoid normal stream disconnects surfacing as server errors | Treats aiohttp `ClientConnectionResetError`, `ConnectionResetError`, and `BrokenPipeError` as normal SSE client disconnects | Pass |

## Runtime Compatibility

The current bundled Hermes runtime's `PlatformEntry` does not expose the newer
`env_enablement_fn` or `cron_deliver_env_var` fields documented publicly. The
adapter only passes those fields when the loaded runtime supports them. This
keeps the pinned runtime from failing plugin registration while preserving exact
behavior on newer Hermes runtimes.

Agent UI still explicitly enables the platform in Hermes `config.yaml` through
`platforms.local_desktop.enabled: true`, so the pinned runtime has a concrete
configuration path even without env-driven auto-enablement support.

## Reference Platform File-Set Audit

Reference platform: `bluebubbles`

New platform: `local_desktop`

Command shape:

```sh
rg -l -u "bluebubbles" -g "*.py" build/hermes-runtime/hermes-agent vendor src test scripts docs README.md
rg -l -u "local_desktop" -g "*.py" build/hermes-runtime/hermes-agent vendor src test scripts docs README.md
rg -l -u "bluebubbles" -g "*.md" build/hermes-runtime/hermes-agent vendor src test scripts docs README.md
rg -l -u "local_desktop" -g "*.md" build/hermes-runtime/hermes-agent vendor src test scripts docs README.md
rg -l -u "bluebubbles" -g "*.ts" -g "*.tsx" build/hermes-runtime/hermes-agent vendor src test scripts docs README.md
rg -l -u "local_desktop" -g "*.ts" -g "*.tsx" build/hermes-runtime/hermes-agent vendor src test scripts docs README.md
```

### Python Gaps

The `.py` files that mention `bluebubbles` but not `local_desktop` fall into
these buckets:

| Bucket | Files | Classification |
| --- | --- | --- |
| Built-in platform enum and env seeding | `gateway/config.py`, `build/lib/gateway/config.py` | Skip for Agent UI. `local_desktop` is a plugin platform; dynamic `Platform("local_desktop")` is supported by bundled plugin scanning. |
| Built-in adapter factory and built-in auth maps | `gateway/run.py`, `build/lib/gateway/run.py` | Skip. Plugin adapters are discovered through `platform_registry`; plugin auth env vars are read from registered `PlatformEntry` metadata. |
| Built-in platform-specific implementation | `gateway/platforms/bluebubbles.py`, `build/lib/gateway/platforms/bluebubbles.py`, `gateway/platforms/helpers.py`, `build/lib/gateway/platforms/helpers.py` | Skip. `local_desktop` implementation lives in `plugins/platforms/local_desktop/adapter.py`. |
| Built-in CLI/setup/config metadata | `hermes_cli/config.py`, `hermes_cli/setup.py`, `hermes_cli/gateway.py`, `hermes_cli/platforms.py`, and `build/lib/...` copies | Skip for pinned runtime. `local_desktop` now exposes rich `plugin.yaml` env metadata; latest Hermes reads plugin env metadata without hardcoded config entries. |
| Built-in toolset and direct send-message routing | `toolsets.py`, `tools/send_message_tool.py`, `build/lib/toolsets.py`, `build/lib/tools/send_message_tool.py` | Skip. Plugin platforms route through the live adapter fallback rather than direct built-in `_send_bluebubbles` code. |
| Cron/home-channel built-in maps | `cron/scheduler.py`, `build/lib/cron/scheduler.py` | Compatibility-gated. Latest Hermes supports `cron_deliver_env_var`; the pinned bundled runtime does not expose that PlatformEntry field yet. |
| Built-in display/prompt/webhook special cases | `agent/prompt_builder.py`, `gateway/display_config.py`, `gateway/platforms/webhook.py`, and `build/lib/...` copies | Skip unless a concrete local desktop UX requirement appears. Current `platform_hint`, PII flag, and gateway events cover the Agent UI path. |
| Built-in tests for BlueBubbles behavior | `tests/gateway/test_bluebubbles.py`, plus display/session tests mentioning BlueBubbles | Skip. `local_desktop` has its own adapter and gateway tests. |
| Migration-only references | `optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py` | Skip. Not part of Agent UI runtime behavior. |

No `.py` gap requires adding `local_desktop` to Hermes built-in platform
enumerations for the Agent UI vendored plugin path.

### Markdown And TypeScript Gaps

The `.md` and `.ts` gaps are Hermes website/docs surfaces for BlueBubbles:

- `website/docs/user-guide/messaging/bluebubbles.md`
- messaging and integrations index pages
- cron, sessions, architecture, gateway internals, toolsets reference pages
- `website/sidebars.ts`

Classification: skip for Agent UI. Those are public Hermes website docs for a
built-in user messaging platform. Agent UI keeps local desktop documentation in
this repo and does not patch the bundled Hermes website tree as part of runtime
packaging.

If `local_desktop` is upstreamed into Hermes as an official built-in platform,
that upstream PR should add first-class Hermes website pages and sidebar entries.
For the current Agent UI vendored plugin, the absence of those docs is not a
runtime architecture gap.
