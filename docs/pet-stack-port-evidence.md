# Pet Stack Port Evidence

This evidence ledger is subordinate to `docs/lean-product-contract.md`. When Codex.app behavior conflicts with the lean contract, agent-UI intentionally follows the lean contract.

## Static Codex.app Evidence

Target: `/Applications/Codex.app`

Commands:

```bash
python3 /Users/saminkhan1/.codex/skills/reverse-engineer-macos-apps/scripts/ui_porting_inventory.py --format json --term avatar-overlay --term openAvatarOverlay --term codex-avatar --term Activity --term notification --term avatar-overlay-element-size-changed --term avatar-overlay-pointer-interaction-changed --term avatar-overlay-keyboard-interaction-changed --term avatar-overlay-drag-release --term needs-input --term Dismiss --term Reply --term Latest --term older --include-source-maps /Applications/Codex.app > /tmp/agent-ui-codex-avatar-deep-inventory.json
python3 /Users/saminkhan1/.codex/skills/reverse-engineer-macos-apps/scripts/macos_app_triage.py --format json --search avatar-overlay --search openAvatarOverlay --search codex-avatar --search avatar-overlay-drag-release /Applications/Codex.app > /tmp/agent-ui-codex-avatar-triage.json
npx asar extract /Applications/Codex.app/Contents/Resources/app.asar /tmp/codex-pet-deep/extract
npx esbuild /tmp/codex-pet-deep/extract/webview/assets/codex-avatar-BpKnWN_W.js --bundle=false --format=esm --minify=false --outfile=/tmp/codex-pet-deep/codex-avatar.pretty.js
npx esbuild /tmp/codex-pet-deep/extract/webview/assets/avatar-overlay-page-Dj9Zinq_.js --bundle=false --format=esm --minify=false --outfile=/tmp/codex-pet-deep/avatar-overlay-page.pretty.js
npx esbuild /tmp/codex-pet-deep/extract/.vite/build/workspace-root-drop-handler-B4gQVO2J.js --bundle=false --format=esm --minify=false --outfile=/tmp/codex-pet-deep/workspace-root-drop-handler.pretty.js
plutil -p /Applications/Codex.app/Contents/Info.plist
codesign -dv --verbose=4 /Applications/Codex.app
codesign -d --entitlements :- /Applications/Codex.app
shasum -a 256 /Applications/Codex.app/Contents/Resources/app.asar
```

Codex.app build inspected:

- Bundle id: `com.openai.codex`
- Version: `26.429.30905`, build `2345`
- ASAR SHA-256: `00ed2c4baa639c8ce690507adfa5c9eb474703d07bb88f4eeea76c35aa888614`
- Signed by `Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)` and notarized. Entitlements include network client, Apple Events automation, audio input, user-selected read/write files, JIT, unsigned executable memory, and no app sandbox.
- JS chunks reference `.map` files, but the referenced source maps are not present in the packaged app.

Working set:

- `.vite/build/main-DlFGMsC6.js`
- `.vite/build/workspace-root-drop-handler-B4gQVO2J.js`
- `.vite/build/worker.js`
- `webview/assets/avatar-overlay-page-Dj9Zinq_.js`
- `webview/assets/appearance-settings-BAlI9-Z-.js`
- `webview/assets/codex-avatar-BpKnWN_W.js`
- `webview/assets/codex-avatar-D82knaKt.css`
- `webview/assets/use-floating-window-pointer-interactivity-BZT8RRB7.js`
- `webview/assets/avatar-overlay-open-state-signal-BGjzvfQc.js`
- `webview/assets/index-DJATSIwz.js`

## Fast Next-Time Workflow

Use this order for future `/pet` parity work. It avoids the main mistake from the first pass: static bundle constants are not enough for pixel parity.

1. Start from the lean contract, then only override it where the contract says Codex-like UI is required:

```bash
sed -n '192,215p' docs/lean-product-contract.md
sed -n '425,429p' docs/lean-product-contract.md
```

2. Extract and prettify the exact Codex.app build being compared:

```bash
TARGET=/Applications/Codex.app
LAB=/tmp/codex-pet-deep
rm -rf "$LAB"
mkdir -p "$LAB"
npx asar extract "$TARGET/Contents/Resources/app.asar" "$LAB/extract"
find "$LAB/extract" -type f | rg 'avatar|codex-avatar|appearance|floating|workspace-root|main|index'
npx esbuild "$LAB/extract/webview/assets/codex-avatar-BpKnWN_W.js" --bundle=false --format=esm --minify=false --outfile="$LAB/codex-avatar.pretty.js"
npx esbuild "$LAB/extract/webview/assets/avatar-overlay-page-Dj9Zinq_.js" --bundle=false --format=esm --minify=false --outfile="$LAB/avatar-overlay-page.pretty.js"
npx esbuild "$LAB/extract/.vite/build/workspace-root-drop-handler-B4gQVO2J.js" --bundle=false --format=esm --minify=false --outfile="$LAB/workspace-root-drop-handler.pretty.js"
```

3. Search for behavior, not just filenames:

```bash
rg -n "custom-avatars|pet.json|avatar.json|spritesheet|1536|1872|VP8X|VP8L|selected-avatar-id|openAvatarOverlay|Wake Pet|avatar-overlay-drag-release|avatar-overlay-element-size-changed|avatar-overlay-pointer-interaction-changed|avatar-overlay-keyboard-interaction" "$LAB"
```

4. Launch Codex.app in an isolated lab profile and inspect the live overlay through CDP. Do not use the normal user profile for reverse-engineering runs:

```bash
RUNTIME=/tmp/codex-pet-runtime-$(date +%s)
mkdir -p "$RUNTIME/codex-home" "$RUNTIME/userData"
CODEX_HOME="$RUNTIME/codex-home" \
CODEX_ELECTRON_USER_DATA_PATH="$RUNTIME/userData" \
BUILD_FLAVOR=agent \
/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9341
```

5. Find the overlay page. The target only exists once the pet has been woken through `/pet`, the Wake Pet command, or persisted open state:

```bash
curl -s http://127.0.0.1:9341/json/list | jq -r '.[] | [.type, .url] | @tsv' | rg 'avatar-overlay|webview|app://'
```

6. Snapshot computed geometry with Playwright. Keep `backgroundImage` truncated because custom pets are large data URLs:

```bash
node <<'NODE'
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9341');
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().includes('avatar-overlay')) || pages[0];
  await page.waitForTimeout(800);
  const data = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const style = (el, props) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)]));
    };
    const avatar = q('.codex-avatar-root');
    const mascot = q('[data-avatar-mascot="true"]');
    const hit = q('[data-avatar-overlay-hit-region="mascot"]');
    const frame = q('[data-avatar-overlay-content-frame="true"]');
    const bg = avatar ? getComputedStyle(avatar).backgroundImage : '';
    return {
      url: location.href,
      viewport: { innerWidth, innerHeight, devicePixelRatio },
      frame: { rect: rect(frame), className: frame?.className || null },
      hit: { rect: rect(hit), dataset: hit ? { ...hit.dataset } : null, style: style(hit, ['cursor', 'pointer-events', '-webkit-app-region']) },
      mascot: { rect: rect(mascot), dataset: mascot ? { ...mascot.dataset } : null, className: mascot?.className || null },
      avatar: {
        rect: rect(avatar),
        dataset: avatar ? { ...avatar.dataset } : null,
        className: avatar?.className || null,
        style: {
          ...style(avatar, ['width', 'height', 'aspect-ratio', 'background-size', 'background-position', 'image-rendering', 'flex-shrink']),
          backgroundImagePrefix: bg.slice(0, 30),
          backgroundImageLength: bg.length,
        },
      },
    };
  });
  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})();
NODE
```

7. Only after live geometry is captured, patch agent-UI and run the same CDP snapshot against the local Electron build:

```bash
AGENT_UI_EVAL=1 \
AGENT_UI_EVAL_PORT_FILE=/tmp/agent-ui-pet-parity/eval-port.txt \
CODEX_HOME=/tmp/agent-ui-pet-parity/codex-home \
AGENT_UI_CONFIG_DIR=/tmp/agent-ui-pet-parity/config \
./node_modules/.bin/electron . --remote-debugging-port=9351

PORT=$(cat /tmp/agent-ui-pet-parity/eval-port.txt)
curl -s "http://127.0.0.1:$PORT/ui-targets"
```

8. Cleanup lab processes before finishing:

```bash
pgrep -fl 'remote-debugging-port=9341|remote-debugging-port=9351'
# Then terminate only the isolated lab PIDs you started.
```

Codex avatar mechanics:

- `codex-avatar-D82knaKt.css` defines a single `.codex-avatar-root` with `aspect-ratio: 192/208`, `width: 7.04rem`, `image-rendering: pixelated`, `background-repeat: no-repeat`, and `background-size: 800% 900%`.
- `codex-avatar-BpKnWN_W.js` animates by setting `backgroundPosition` on `.codex-avatar-root`; custom avatars supplied by the app use `assetRef: "codex"` plus a custom `spritesheetUrl`.
- The fixed sprite grid is 8 columns by 9 rows. Idle uses row 0 columns 0-5 with durations `280, 110, 110, 140, 140, 320` ms and the long idle loop multiplies those by 6. Non-idle states run three times and then enter long idle. State rows are `running: 7`, `waiting: 6`, `failed: 5`, `review: 8`, `jumping: 4`, `waving: 3`, `running-right: 1`, and `running-left: 2`.

Codex custom pet package mechanics:

- The packaged app does not contain the literal string `hatch-pet`; it contains the consumer for hatch-pet-compatible output.
- `custom-avatars` scans two user directories: `<codex-home>/pets` using `pet.json`, and legacy `<codex-home>/avatars` using `avatar.json`.
- Codex creates the `pets` directory if it does not exist. It tolerates legacy avatar read failures, then merges legacy avatars and pets by id, with pets overriding duplicate ids.
- A pet package is a subdirectory containing a manifest and sprite file. The manifest accepts optional `id`, optional `displayName`, optional nullable `description`, and `spritesheetPath` defaulting to `spritesheet.webp`.
- Sprite paths are resolved relative to the package directory and rejected if they escape the package.
- Sprites must be PNG or WebP and must be exactly `1536x1872`. Codex has explicit WebP dimension handling for `VP8X`, `VP8L`, and `VP8`.
- Accepted custom packages are exposed to the renderer as `id: custom:<directoryName>`, `displayName`, `description`, and a base64 `spritesheetDataUrl`.
- The three local agent-UI sheets currently match Codex dimensions: `goblin` `1536x1872 VP8L`, `i-rocky` `1536x1872 VP8L`, and `teemo` `1536x1872 VP8X`.
- The public Codex Pet Share page at `https://codex-pet-share.pages.dev/` uses the same package shape. Its generated install command writes package directories under `$HOME/.codex/pets/<id>`, and the page currently exposes pets through the Supabase `petshare/api/pets` endpoint.
- On 2026-05-02 the first-page API response returned `total: 376` and example ids `bao`, `sir-willy`, and `plato`. Treat that count as historical evidence only; the live catalog can change.

Codex overlay window and drag mechanics:

- Main-process persisted keys are `electron-avatar-overlay-open` and `electron-avatar-overlay-bounds`.
- The overlay route is `/avatar-overlay`; the default window is `356x320`, mascot default is `112x121`, tray default is `276x131`, and bottom-right margin is `24`.
- The layout scorer tries `top-start`, `top-end`, `bottom-start`, and `bottom-end`, prefers the side away from the screen center, and gives the previous placement a `96` point stickiness advantage.
- The mascot is clamped with bottom padding, while the tray is clamped to the display edge without that bottom padding.
- The renderer sends `avatar-overlay-element-size-changed`; the main process updates mascot/tray sizes, recomputes layout, persists bounds, and sends `avatar-overlay-layout-changed`.
- Drag uses renderer pointer capture. A click on the mascot without movement dispatches `open-current-main-window`; movement sends drag start/move/end.
- Fling release sends velocity to the main process. Codex applies momentum every `16ms`, decays velocity by `0.88`, stops under `65px/s`, and caps the throw at `900ms`.
- During horizontal drag, the renderer uses `running-right` or `running-left` once movement exceeds `4px`.
- The overlay window is non-focusable by default for pointer pass-through. Pointer interactivity is driven by renderer hit testing over `[data-avatar-overlay-hit-region]` and `[data-avatar-mascot='true']`; keyboard interaction temporarily enables focus and sends `avatar-overlay-keyboard-interaction-ready`.

Codex settings and command surface:

- The pet feature is gated by Statsig gate `2679188970`.
- Appearance settings render a `Pets` section when enabled. It separates built-ins from custom pets, shows the custom pet folder path, offers `Refresh`, `Open folder`, and wake/tuck controls, and stores selection in `selected-avatar-id`.
- Built-in avatar ids are `codex`, `dewey`, `fireball`, `rocky`, `seedy`, `stacky`, `bsod`, and `null-signal`.
- The command surface defines `openAvatarOverlay` with menu title `Wake Pet`. The command dispatches `avatar-overlay-open`; when the overlay is already open the related menu text becomes tuck-away behavior.

## Dynamic Codex.app Runtime Evidence

Codex.app was also launched in an isolated lab profile, not against the user's normal app data:

```bash
CODEX_HOME=/tmp/codex-pet-runtime-open-1777760625/codex-home \
CODEX_ELECTRON_USER_DATA_PATH=/tmp/codex-pet-runtime-open-1777760625/userData \
BUILD_FLAVOR=agent \
/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9341
```

CDP target discovery found the live pet overlay at:

```text
app://-/index.html?initialRoute=%2Favatar-overlay&hostId=local
```

Live overlay measurements:

- Viewport: `356x320`, DPR `2`.
- Content frame: `<section data-avatar-overlay-content-frame="true" class="relative h-full w-full cursor-grab active:cursor-grabbing">`.
- Mascot hit region: `left=248`, `top=225`, `width=80`, `height=87`, cursor `grab`.
- Mascot element: `left=248`, `top=225`, `width=80`, `height=80`, class `relative flex size-20 cursor-interaction items-center justify-center active:cursor-grabbing`.
- Avatar root: `left=248`, `top=221.671875`, `width=80`, `height=86.6640625`, `aspect-ratio=192 / 208`, `background-size=800% 900%`, `image-rendering=pixelated`, `data-avatar-state=idle`, `data-avatar-asset-ref=codex`.
- The `112x121` mascot size in main-process code is a pre-measurement default. The live renderer uses a `size-20` mascot container and allows the `.codex-avatar-root` to flex-shrink from `7.04rem` to `80px`, yielding the observed `80x86.6640625` sprite.
- Runtime screenshot was captured at `/tmp/codex-pet-runtime-open-1777760625/avatar-overlay.png`.

Local parity runtime was then launched with `CODEX_HOME=/tmp/agent-ui-pet-parity/codex-home`, `AGENT_UI_CONFIG_DIR=/tmp/agent-ui-pet-parity/config`, and CDP port `9351`.

Verified local overlay measurements after the port:

- Eval window bounds: `356x320`.
- Layout: mascot `left=248`, `top=225`, `width=80`, `height=87`; tray `left=52`, `top=90`, `width=276`, `height=131`; placement `top-end`.
- Mascot element: `left=248`, `top=225`, `width=80`, `height=80`, cursor `grab`, `touch-action=none`.
- Avatar root: `left=248`, `top=221.671875`, `width=80`, `height=86.6640625`, `aspect-ratio=192 / 208`, `background-size=800% 900%`, `image-rendering=pixelated`, `flex-shrink=1`, `data-avatar-state=idle`, `data-avatar-pet-id=custom:goblin`.

## Assumptions Corrected

- The main-process `112x121` mascot default is not the visible pet size. It is only the startup fallback before the renderer reports element measurements.
- The rendered mascot hit box is `80x87`; the button/container is `80x80`; the sprite root is `80x86.6640625`.
- Leaving `.codex-avatar-root` as `flex: 0 0 auto` is wrong for parity. Codex lets the `7.04rem` avatar root flex-shrink inside a `size-20` container.
- Centering the stage content with `align-items:center`/`justify-content:center` introduces a visible vertical offset. The hit region should be placed at `top=225`; the avatar root naturally extends upward to `top=221.671875`.
- The public `hatch-pet` generator name does not appear as a literal in the packaged app. Codex.app contains the runtime consumer for hatch-pet-compatible package output.
- Codex Pet Share packages are not arbitrary sprite sheets. They are Codex-format 8x9 sprite sheets with exact `1536x1872` dimensions.
- Do not mirror Codex notification expiry blindly. `docs/lean-product-contract.md` explicitly makes the pet stack persistent and forbids TTL-style removal.
- Playwright CDP pointer events can inspect DOM state, but they do not fully prove OS-level window drag physics because the main process reads `screen.getCursorScreenPoint()`. Use geometry and code parity for drag unless a physical pointer-driving tool is added.

## Port Implementation Map

These files are the current port surface:

- `assets/pets/goblin/pet.json` and `assets/pets/goblin/spritesheet.webp`: bundled Codex-format package.
- `assets/pets/i-rocky/pet.json` and `assets/pets/i-rocky/spritesheet.webp`: bundled Codex-format package.
- `assets/pets/teemo/pet.json` and `assets/pets/teemo/spritesheet.webp`: bundled Codex-format package.
- `src/main/index.js`: package scanning, sprite dimension parsing, `CODEX_HOME` pet folder handling, selected pet persistence, app/context menu actions, renderer IPC, drag anchoring, and momentum.
- `src/preload/index.js`: safe bridge for pet characters, refresh, drag start/move/end/release, layout, pointer, and keyboard interaction.
- `src/renderer/src/renderer.js`: Codex sprite grid/timing, data URL sprite selection, preloading, `.codex-avatar-root` animation, pointer-capture drag sampling, horizontal running state, fling velocity calculation, and mascot rendering.
- `src/renderer/src/styles.css`: live Codex sizing and CSS behavior for `.pet-stage`, `.pet-mascot`, and `.codex-avatar-root`.
- `docs/pet-stack-port-evidence.md`: this evidence ledger and repeatable playbook.

Important constants now mirrored in agent-UI:

- Package id prefix: `custom:`
- Manifest files: `pet.json` and legacy `avatar.json`
- Default sprite path: `spritesheet.webp`
- Sprite dimensions: `1536x1872`
- Sprite grid: `8x9`
- Avatar aspect ratio: `192 / 208`
- Avatar background size: `800% 900%`
- Idle durations: `280, 110, 110, 140, 140, 320`
- Long idle multiplier: `6`
- Non-idle lead loop count before long idle: `3`
- Drag threshold: `4px`
- Drag sample window: `100ms`
- Fling min/max: `320px/s` and `1600px/s`
- Momentum interval/decay/stop/max: `16ms`, `0.88`, `65px/s`, `900ms`

## Local Verification Commands

Run these after future pet parity edits:

```bash
npm test
npm run build
```

Then run the isolated local runtime:

```bash
rm -rf /tmp/agent-ui-pet-parity
mkdir -p /tmp/agent-ui-pet-parity/codex-home /tmp/agent-ui-pet-parity/config
AGENT_UI_EVAL=1 \
AGENT_UI_EVAL_PORT_FILE=/tmp/agent-ui-pet-parity/eval-port.txt \
CODEX_HOME=/tmp/agent-ui-pet-parity/codex-home \
AGENT_UI_CONFIG_DIR=/tmp/agent-ui-pet-parity/config \
./node_modules/.bin/electron . --remote-debugging-port=9351
```

Expected `/ui-targets` shape for an idle pet:

```json
{
  "overlay": {
    "visible": true,
    "bounds": { "width": 356, "height": 320 },
    "layout": {
      "mascot": { "left": 248, "top": 225, "width": 80, "height": 87 },
      "placement": "top-end",
      "tray": { "left": 52, "top": 90, "width": 276, "height": 131 },
      "viewport": { "width": 356, "height": 320 }
    }
  }
}
```

Expected CDP DOM geometry:

```json
{
  "viewport": { "innerWidth": 356, "innerHeight": 320, "devicePixelRatio": 2 },
  "avatar": {
    "rect": { "left": 248, "top": 221.671875, "width": 80, "height": 86.6640625 },
    "style": {
      "aspect-ratio": "192 / 208",
      "background-size": "800% 900%",
      "image-rendering": "pixelated",
      "flex-shrink": "1"
    }
  },
  "mascot": { "rect": { "left": 248, "top": 225, "width": 80, "height": 80 } },
  "stage": { "rect": { "left": 248, "top": 225, "width": 80, "height": 87 } }
}
```

After verification, shut the local eval process down through its eval server:

```bash
PORT=$(cat /tmp/agent-ui-pet-parity/eval-port.txt)
curl -s -X POST "http://127.0.0.1:$PORT/shutdown"
```

## Port Decisions

- Stack persistence: Codex.app uses per-status expiry windows and dismissed turn keys in `avatar-overlay-page-Dj9Zinq_.js`. The lean contract forbids TTL hiding and temporary notification semantics, so agent-UI keeps submitted sessions visible until explicit terminal dismiss.
- Needs input: Codex.app derives waiting state from structured runtime flags and request-user-input records. Hermes `chat --quiet --query` does not currently document an equivalent agent-UI waiting event, so agent-UI does not expose inline reply from Hermes output.
- Tray layout: Codex.app clamps the mascot with bottom padding but clamps the tray to the display edge without that bottom padding. agent-UI now mirrors that split to keep stack alignment stable.
- Default tray sizing: Codex.app lays out against a default `276x131` tray before renderer measurement. agent-UI now does the same to avoid first-render tray misalignment.
- Pointer hit testing: Codex.app reports renderer-side avatar/tray hit regions back to the main process with `avatar-overlay-pointer-interaction-changed`. agent-UI now mirrors that with `pet-pointer-interaction-changed`, using DOM `elementsFromPoint` over `[data-avatar-overlay-hit-region]` and `[data-avatar-mascot="true"]`. The older screen-rect polling remains only as a startup fallback before the renderer has reported exact pointer state.
- Avatar assets: agent-UI vendors Codex/hatch-pet packages under `assets/pets/`, scans `<CODEX_HOME>/pets/*/pet.json` plus legacy `<CODEX_HOME>/avatars/*/avatar.json`, validates package-contained PNG/WebP sprites at exactly `1536x1872`, prefixes package ids as `custom:<directoryName>`, exposes data URL sprites to the renderer, and animates the `.codex-avatar-root` background directly with the same 8x9 frame grid and state durations. No nested scaled sprite frame is used.
- Drag and release: agent-UI now follows Codex's renderer pointer-capture model, horizontal drag state switching, main-process window movement, and momentum release constants.
- Follow-up resume: The lean contract requires Hermes resume semantics. agent-UI now refuses follow-up submission until a Hermes session id is available instead of silently starting a non-resumed turn.
- Eval artifacts: Each Hermes CLI call now writes a stable per-call artifact under `runs/run-###/` while preserving the existing latest `prompt.txt`/`stdout.log`/`stderr.log` paths. This keeps the initial context-tagged prompt inspectable after a resumed follow-up overwrites the latest prompt.
- Pet stack row expansion: Codex measures rendered body overflow (`scrollHeight > 32px + 1px`) before showing the expand control. agent-UI now mirrors that instead of using a character-count heuristic.
- Pet stack row body source: running rows may show the current streamed bubble, but terminal rows prefer the finish bubble from the completed Hermes turn. This prevents a completed or resumed session row from staying stuck on an older streaming line.
- Needs-input bridge: removed the speculative `agent-ui-status` / `agent-ui.status` parser after checking the local AURA wrapper and Hermes CLI docs/source. Current status derivation is process-based only: running child process, zero exit, nonzero exit, or user cancellation.

## Runtime Validation Update 2026-05-02

Local runtime was launched with:

```bash
AGENT_UI_EVAL=1 \
AGENT_UI_EVAL_PORT_FILE=/tmp/agent-ui-pet-parity-run2/eval-port.txt \
CODEX_HOME=/tmp/agent-ui-pet-parity-run2/codex-home \
AGENT_UI_CONFIG_DIR=/tmp/agent-ui-pet-parity-run2/config \
./node_modules/.bin/electron . --remote-debugging-port=9352
```

Real-Hermes path verified:

- Global shortcut opened the launcher and captured foreground context before the modal took focus.
- Initial prompt returned `AGENT_UI_E2E_OK. Codex` and stored Hermes session id `20260502_190054_731c73`.
- Follow-up returned `AGENT_UI_FOLLOWUP_OK.` and `runs/run-002/input.json` showed `--resume 20260502_190054_731c73`.
- The stack row returned to `running` during the follow-up, then back to `review`.
- After the follow-up completed, the row body showed `AGENT_UI_FOLLOWUP_OK.`, `data-can-expand="false"`, no inline reply, and a dismiss control.

## Remaining Pet Parity Gaps

- agent-UI exposes pet choice from the app menu and mascot context menu, while Codex exposes it from Appearance settings with the full built-in/custom split and wake/tuck affordances.
- agent-UI follows the lean contract by keeping submitted sessions persistent instead of using Codex notification expiry windows.

## Real Hermes Verification

Run id: `manual-real-hermes-codex-20260502-1604`

Observed user path:

- Finder was activated, then the normal global shortcut opened the launcher.
- Prompt submitted through the launcher: `Reply exactly: AGENT_UI_E2E_OK. Also name the active app from the provided context metadata.`
- Current local dev should resolve Hermes through `/Users/saminkhan1/Documents/hermes/script/aura-hermes`.
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

## Runtime Evidence Scope

Codex.app runtime inspection used a separate `CODEX_HOME` and Electron user data path. No normal user Codex profile, account data, local conversation data, logs, or network traffic were inspected. Packaged source maps were referenced by chunks but were not present in the app bundle.
