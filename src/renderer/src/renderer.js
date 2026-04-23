/* global cursorcats */
(function () {
  const MARGIN = 8;
  const BOTTOM_MARGIN = 0; // cats walk flush on the bottom edge of the window
  /** When true, cats can climb the frontmost app window; after it stays stable long enough, all floor cats gather there until you switch windows. */
  const PERCH_ON_OTHER_WINDOWS = true;
  const WALK_SPEED = 60; // px/s
  const SPRINT_SPEED = 220; // px/s (~3.7x walk)
  const SPRINT_CHANCE = 0.15;
  /** Nudge sprint target slightly inward from horizontal bounds. */
  const SPRINT_EDGE_MARGIN = 8;
  /** Pixels to nudge the defender when a fight ends. */
  const FIGHT_KNOCKBACK = 48;
  /** Desired horizontal gap between hitboxes when an interaction starts (world px). */
  const CONTACT_GAP = 2;
  /** After any interaction, cats ignore new collisions until this (random range applied in code). */
  const INTERACT_COOLDOWN_MIN = 3000;
  const INTERACT_COOLDOWN_MAX = 6000;
  const PASSTHROUGH_COOLDOWN = 1000;
  const POST_INTERACT_IDLE_MIN = 200;
  const POST_INTERACT_IDLE_MAX = 500;
  const PERCH_CHANCE_PER_IDLE = 0.12;
  const PERCH_MIN_WIDTH = 120;
  const PERCH_DURATION_MIN = 18000;
  const PERCH_DURATION_MAX = 45000;
  /** Zig-zag climb up the side of a window: N small hops alternating left/right. */
  const STAGGER_STEPS = 4;
  /** Per-hop duration; eased motion (see `easeClimbStep`) keeps the ascent soft. */
  const STAGGER_STEP_MS = 300;
  const STAGGER_STEP_LIFT = 18;
  const STAGGER_OFFSET = 22;
  const STABLE_THRESHOLD_MS = 30000;
  /** How often the renderer checks front-window id / stability (IPC reads main’s cached state). */
  const FRONT_WINDOW_POLL_MS = 500;
  const FALL_GRAVITY = 2200;
  const FALL_MAX_VX = 120;
  const PERCH_REQUERY_MS = 500;
  const PERCH_BOUNDS_DRIFT = 24;
  /** Vertical offset per cat when several are perched on the same stable front window (slight stack). */
  const STABLE_PERCH_STACK_DY = 10;
  /** Block ground interactions while commuting / on another window. */
  const INTERACT_BLOCK_MAX = 1e9;
  /** After this long roaming on the floor finished, a cat pops back up to perch on the active window and reshow its "finished" bubble. */
  const FINISH_RESHOW_INTERVAL_MS = 60 * 1000;
  /** Backoff between reshow attempts when the active window can't be used (missing, too narrow). */
  const FINISH_RESHOW_RETRY_MS = 4000;
  /** How long a reshowing cat sits on top of the active window before falling back to the floor. */
  const FINISH_RESHOW_PERCH_MIN_MS = 12000;
  const FINISH_RESHOW_PERCH_MAX_MS = 28000;

  const canvas = document.getElementById('cat');
  const ctx = canvas.getContext('2d', { alpha: true });
  const bubbleLayer = document.getElementById('bubble-layer');

  /** Finish bubbles: keep short; they only stay on screen for `FINISH_BUBBLE_MS`. */
  const FINISH_BUBBLE_MS = 30 * 1000;
  /** Live assistant “cat line” bubble while the agent is streaming. */
  const STREAM_BUBBLE_MS = 12 * 1000;
  /** Shown in a bubble when an agent cat completes its task (random pick per cat). */
  const FINISH_BUBBLE_MESSAGES = [
    'Camp struck—rest well.',
    'Ink dried on this patch.',
    'Ship slipped the harbor.',
    'Trail mapped; paws tired.',
    'Yarn ball: fully sorted.',
    'Kettle off the hob.',
    'Flags down for now.',
    'Scroll stowed, lid worthy.',
    'Burrow door latched tight.',
    'Sunset on this sprint.',
    'Breadcrumbs lead home.',
    'Thread tied; bow optional.',
    'Hatch battened, sky clear.',
    'Tiny parade—route filed.',
    'Feather in the cap.',
    'Curtain down; house lights.',
    'Den swept; ghosts evicted.',
    'Letter mailed; pigeon tired.',
    'Fish counted; net folded.',
    'Patch planted; rain scheduled.',
    'Lighthouse duty: relieved.',
    'Anchor up; tide agrees.',
    'Mission unmoused. For now.',
  ];

  let dpr = 1;
  let manifestPaths = null; // cached list of sprite manifest relative paths
  const assetCache = new Map(); // manifestRel -> { manifest, img, hitbox }

  /** All active cats. Each cat has its own manifest, hue-shifted sprite canvas, position, and animation state. */
  const cats = [];

  /** `agent-finished` can fire before async `spawnCat` finishes loading assets. */
  const pendingFinishes = new Map();
  let nextFinishedOrder = 0;

  /** Last counts sent to main for dock / tray menu (skip duplicate sends). */
  let lastSentCatCountsKey = '';

  function snapshotCatCounts() {
    let active = 0;
    let inReview = 0;
    for (const c of cats) {
      if (c.finished || c.finishReshowing) inReview += 1;
      else active += 1;
    }
    return { active, inReview };
  }

  function reportCatCountsIfChanged() {
    if (!window.cursorcats || typeof window.cursorcats.reportCatCounts !== 'function') return;
    const snap = snapshotCatCounts();
    const key = `${snap.active},${snap.inReview}`;
    if (key === lastSentCatCountsKey) return;
    lastSentCatCountsKey = key;
    window.cursorcats.reportCatCounts(snap);
  }

  /** Last frontmost window id from main; used to detect focus changes and drop perched cats. */
  let trackedFrontWindowId = null;
  let stabilityNudgeTimer = null;

  let lastFrameTime = 0;
  let rafStarted = false;

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  /** Softer than linear, without full stops between stagger hops. */
  function easeClimbStep(p) {
    const t = Math.min(1, Math.max(0, p));
    const smooth = t * t * (3 - 2 * t);
    return t * 0.42 + smooth * 0.58;
  }

  /** Path to PNG (or other image) for a sprite manifest under `assets/cats/`. */
  function resolveCatImagePath(manifestRel, imageFilename) {
    const norm = manifestRel.replace(/\\/g, '/');
    const lastSlash = norm.lastIndexOf('/');
    const subdir = lastSlash === -1 ? '' : norm.slice(0, lastSlash + 1);
    return `assets/cats/${subdir}${imageFilename}`;
  }

  async function readCatManifestPaths() {
    const fallback = ['sprite.json'];
    try {
      const text = await window.cursorcats.readTextFile('assets/cats/cats.json');
      const data = JSON.parse(text);
      const arr = data && data.manifests;
      if (!Array.isArray(arr)) return fallback;
      const paths = arr.filter((x) => typeof x === 'string' && x.trim().length > 0);
      return paths.length ? paths : fallback;
    } catch {
      return fallback;
    }
  }

  function pickRandomManifest(paths) {
    return paths[Math.floor(Math.random() * paths.length)];
  }

  function getAnimDef(cat, name) {
    if (!cat || !cat.manifest || !cat.manifest.animations) return null;
    return cat.manifest.animations[name] || null;
  }

  function pickWalkAnim(cat, moveRight) {
    if (moveRight) {
      if (getAnimDef(cat, 'walk_right')) return { key: 'walk_right', flip: false };
      if (getAnimDef(cat, 'walk_left')) return { key: 'walk_left', flip: true };
    } else {
      if (getAnimDef(cat, 'walk_left')) return { key: 'walk_left', flip: false };
      if (getAnimDef(cat, 'walk_right')) return { key: 'walk_right', flip: true };
    }
    return { key: 'idle', flip: false };
  }

  /** Prefer `run` while sprinting; otherwise same as walk. */
  function pickMoveAnim(cat, moveRight) {
    if (cat.sprinting && getAnimDef(cat, 'run')) {
      return { key: 'run', flip: !moveRight };
    }
    return pickWalkAnim(cat, moveRight);
  }

  function getDrawSize(cat) {
    const m = cat && cat.manifest;
    const scale = m && typeof m.scale === 'number' ? m.scale : 1;
    const fw = (m && m.frameWidth) || 32;
    const fh = (m && m.frameHeight) || 32;
    return { w: fw * scale, h: fh * scale, fw, fh, scale };
  }

  /** Y so the cat sits on the bottom edge of the work area (horizontal playground only). */
  function getBottomY(cat) {
    const { h } = getDrawSize(cat);
    return Math.max(0, canvas.clientHeight - BOTTOM_MARGIN - h);
  }

  /** How many cats are already stacked on this stable perch before `cat` (for vertical spread). */
  function getStablePerchStackIndex(cat) {
    if (cat.state !== 'perched' || !cat.perchTiedToStableWindow || !cat.perchWindowId) return 0;
    let n = 0;
    for (const c of cats) {
      if (c === cat) break;
      if (
        c.state === 'perched' &&
        c.perchTiedToStableWindow &&
        c.perchWindowId === cat.perchWindowId
      ) {
        n += 1;
      }
    }
    return n;
  }

  /** Baseline: floor or top of front window when perched. */
  function getBaselineY(cat) {
    if (cat.state === 'perched' && cat.perch) {
      const { h } = getDrawSize(cat);
      const stackLift = getStablePerchStackIndex(cat) * STABLE_PERCH_STACK_DY;
      return Math.max(0, cat.perch.top - h - stackLift);
    }
    return getBottomY(cat);
  }

  function getHorizontalRange(cat) {
    const { w } = getDrawSize(cat);
    if (cat.state === 'perched' && cat.perch) {
      if (cat.perchLeaving) {
        return { min: -2 * w, max: Math.max(0, canvas.clientWidth) + w };
      }
      const minP = Math.max(MARGIN, cat.perch.left + MARGIN);
      const maxP = Math.min(
        Math.max(MARGIN, canvas.clientWidth - MARGIN - w),
        cat.perch.right - MARGIN - w
      );
      if (minP > maxP) {
        const c = (cat.perch.left + cat.perch.right) / 2 - w / 2;
        return { min: c, max: c };
      }
      return { min: minP, max: maxP };
    }
    const maxX = Math.max(MARGIN, canvas.clientWidth - MARGIN - w);
    return { min: MARGIN, max: maxX };
  }

  /** Tight bounds of non-transparent pixels in the idle frame (unscaled frame coords). */
  function computeVisibleHitbox(img, manifest) {
    const fw = (manifest && manifest.frameWidth) || 32;
    const fh = (manifest && manifest.frameHeight) || 32;
    const idleAnim = manifest && manifest.animations && manifest.animations.idle;
    const row = idleAnim && typeof idleAnim.row === 'number' ? idleAnim.row : 0;
    const off = document.createElement('canvas');
    off.width = fw;
    off.height = fh;
    const octx = off.getContext('2d', { willReadFrequently: true });
    if (!octx) return { x: 0, y: 0, w: fw, h: fh };
    octx.drawImage(img, 0, row * fh, fw, fh, 0, 0, fw, fh);
    const data = octx.getImageData(0, 0, fw, fh).data;
    let minX = fw;
    let minY = fh;
    let maxX = 0;
    let maxY = 0;
    for (let py = 0; py < fh; py++) {
      const rowOff = py * fw * 4;
      for (let px = 0; px < fw; px++) {
        if (data[rowOff + px * 4 + 3] > 16) {
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      }
    }
    if (minX > maxX) return { x: 0, y: 0, w: fw, h: fh };
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /** World-space hitbox for collision / snapping (respects flipSprite). */
  function getHitboxRect(cat) {
    const m = cat && cat.manifest;
    const scale = m && typeof m.scale === 'number' ? m.scale : 1;
    const fw = (m && m.frameWidth) || 32;
    const fh = (m && m.frameHeight) || 32;
    const hb = cat.hitbox || { x: 0, y: 0, w: fw, h: fh };
    const left = cat.flipSprite ? fw - (hb.x + hb.w) : hb.x;
    return {
      x: cat.x + left * scale,
      y: cat.y + hb.y * scale,
      w: hb.w * scale,
      h: hb.h * scale,
    };
  }

  function rectsOverlap2D(ra, rb) {
    return ra.x < rb.x + rb.w && rb.x < ra.x + ra.w && ra.y < rb.y + rb.h && rb.y < ra.y + ra.h;
  }

  /** 2D overlap using auto-detected visible hitboxes (not full frame padding). */
  function catsOverlap(a, b) {
    return rectsOverlap2D(getHitboxRect(a), getHitboxRect(b));
  }

  /** Slide two walking cats so their hitboxes sit CONTACT_GAP apart; then face each other. */
  function snapCatsToContact(a, b) {
    const MAX_IT = 10;
    for (let iter = 0; iter < MAX_IT; iter++) {
      const ra = getHitboxRect(a);
      const rb = getHitboxRect(b);
      const ca = ra.x + ra.w / 2;
      const cb = rb.x + rb.w / 2;
      const left = ca <= cb ? a : b;
      const right = left === a ? b : a;
      const rL = getHitboxRect(left);
      const rR = getHitboxRect(right);
      const gap = rR.x - (rL.x + rL.w);
      const delta = CONTACT_GAP - gap;
      if (Math.abs(delta) < 0.25) break;
      const x0L = left.x;
      const x0R = right.x;
      left.x -= delta / 2;
      right.x += delta / 2;
      clampPos(left);
      clampPos(right);
      if (left.x === x0L && right.x === x0R) break;
    }
    let ra = getHitboxRect(a);
    let rb = getHitboxRect(b);
    let ca = ra.x + ra.w / 2;
    let cb = rb.x + rb.w / 2;
    let left = ca <= cb ? a : b;
    let right = left === a ? b : a;
    let rL = getHitboxRect(left);
    let rR = getHitboxRect(right);
    let gap = rR.x - (rL.x + rL.w);
    let err = CONTACT_GAP - gap;
    if (Math.abs(err) > 0.25) {
      right.x += err;
      clampPos(right);
      rL = getHitboxRect(left);
      rR = getHitboxRect(right);
      gap = rR.x - (rL.x + rL.w);
      err = CONTACT_GAP - gap;
      if (Math.abs(err) > 0.25) {
        left.x -= err;
        clampPos(left);
      }
    }
    faceEachOther(a, b);
  }

  function faceEachOther(a, b) {
    const ac = a.x + getDrawSize(a).w / 2;
    const bc = b.x + getDrawSize(b).w / 2;
    a.facingRight = bc >= ac;
    b.facingRight = ac >= bc;
  }

  function applyKnockbackDefender(defender, attacker) {
    const defW = getDrawSize(defender).w;
    const attW = getDrawSize(attacker).w;
    const defC = defender.x + defW / 2;
    const attC = attacker.x + attW / 2;
    const away = defC >= attC ? 1 : -1;
    defender.x += away * FIGHT_KNOCKBACK;
    clampPos(defender);
  }

  /** Bias walk target to the side of the screen away from the partner. */
  function pickWalkTargetAwayFrom(cat, partner) {
    const { min, max } = getHorizontalRange(cat);
    const margin = 40;
    const pRight = partner.x + getDrawSize(partner).w;
    const pLeft = partner.x;
    const catW = getDrawSize(cat).w;
    const catCenter = cat.x + catW / 2;
    const pCenter = partner.x + getDrawSize(partner).w / 2;
    if (catCenter <= pCenter) {
      const hi = Math.max(min, pLeft - margin);
      if (hi > min + 4) {
        cat.walkTargetX = rand(min, hi);
      } else {
        cat.walkTargetX = rand(min, max);
      }
    } else {
      const lo = Math.min(max, pRight + margin);
      if (lo < max - 4) {
        cat.walkTargetX = rand(lo, max);
      } else {
        cat.walkTargetX = rand(min, max);
      }
    }
    cat.walkTargetY = getBottomY(cat);
  }

  /** Ground cats that can collide for fights/greets (walk or idle on the floor). */
  function canGroundInteract(a) {
    if (!a) return false;
    if (a.state !== 'walk' && a.state !== 'idle') return false;
    if (a.perch || a.climb || a.fall) return false;
    return true;
  }

  function startInteraction(a, b, ts) {
    if (!a || !b) return;
    if (!canGroundInteract(a) || !canGroundInteract(b)) return;
    if (ts < a.canInteractAt || ts < b.canInteractAt) return;
    if (!catsOverlap(a, b)) return;

    if (a.state === 'idle') a.state = 'walk';
    if (b.state === 'idle') b.state = 'walk';

    const r = Math.random();
    if (r < 0.02) {
      a.canInteractAt = ts + PASSTHROUGH_COOLDOWN;
      b.canInteractAt = ts + PASSTHROUGH_COOLDOWN;
      return;
    }
    a.interactKind = r < 0.97 ? 'fight' : 'greet';
    b.interactKind = a.interactKind;
    a.interactPartner = b;
    b.interactPartner = a;
    const aIsAttacker = Math.random() < 0.5;
    if (a.interactKind === 'fight') {
      a.interactRole = aIsAttacker ? 'attacker' : 'defender';
      b.interactRole = aIsAttacker ? 'defender' : 'attacker';
    } else {
      a.interactRole = 'greeter';
      b.interactRole = 'greeter';
    }
    if (a.interactKind === 'fight') {
      const dur = rand(1200, 1800);
      a.interactEndAt = ts + dur;
      b.interactEndAt = ts + dur;
    } else {
      const dur = rand(1000, 1500);
      a.interactEndAt = ts + dur;
      b.interactEndAt = ts + dur;
    }
    snapCatsToContact(a, b);
    a.state = 'interact';
    b.state = 'interact';
  }

  function finishInteractionPair(a, b, ts) {
    if (!a || !b || a.state !== 'interact' || b.state !== 'interact') return;
    if (a.interactPartner !== b || b.interactPartner !== a) return;
    const kind = a.interactKind;
    if (kind === 'fight') {
      if (a.interactRole === 'defender') applyKnockbackDefender(a, b);
      if (b.interactRole === 'defender') applyKnockbackDefender(b, a);
    }
    for (const c of [a, b]) {
      const other = c === a ? b : a;
      c.interactPartner = null;
      c.interactKind = null;
      c.interactRole = null;
      c.interactEndAt = 0;
      c.state = 'idle';
      c.canInteractAt = ts + rand(INTERACT_COOLDOWN_MIN, INTERACT_COOLDOWN_MAX);
      c.idleEndAt = ts + rand(POST_INTERACT_IDLE_MIN, POST_INTERACT_IDLE_MAX);
      if (!c.finished) {
        if (kind === 'fight' || kind === 'greet') {
          pickWalkTargetAwayFrom(c, other);
        } else {
          pickNewWalkTarget(c);
        }
        maybeStartSprint(c);
      }
    }
  }

  function tryResolveCollisions(ts) {
    for (let i = 0; i < cats.length; i++) {
      for (let j = i + 1; j < cats.length; j++) {
        const a = cats[i];
        const b = cats[j];
        if (!canGroundInteract(a) || !canGroundInteract(b)) continue;
        if (ts < a.canInteractAt || ts < b.canInteractAt) continue;
        if (!catsOverlap(a, b)) continue;
        startInteraction(a, b, ts);
      }
    }
  }

  function clampPos(cat) {
    if (!cat.manifest || !cat.spriteSource) return;
    if (cat.state === 'climbUp' || cat.state === 'fallOff') return;
    const { min, max } = getHorizontalRange(cat);
    cat.x = Math.min(max, Math.max(min, cat.x));
    cat.y = getBaselineY(cat);
  }

  function pickNewWalkTarget(cat) {
    const { min, max } = getHorizontalRange(cat);
    cat.walkTargetX = rand(min, max);
    cat.walkTargetY = getBaselineY(cat);
  }

  /** Random full-width dash toward the far edge; clears sprinting if roll fails. */
  function maybeStartSprint(cat) {
    if (
      cat.state === 'perched' ||
      cat.state === 'walkToPerch' ||
      cat.state === 'fallOff' ||
      cat.state === 'climbUp'
    ) {
      cat.sprinting = false;
      return;
    }
    if (Math.random() >= SPRINT_CHANCE) {
      cat.sprinting = false;
      return;
    }
    cat.sprinting = true;
    const { min, max } = getHorizontalRange(cat);
    let hi = max - SPRINT_EDGE_MARGIN;
    let lo = min + SPRINT_EDGE_MARGIN;
    if (lo > hi) {
      lo = min;
      hi = max;
    }
    const center = canvas.clientWidth / 2;
    const catMid = cat.x + getDrawSize(cat).w / 2;
    cat.walkTargetX = catMid < center ? hi : lo;
    cat.walkTargetX = Math.min(max, Math.max(min, cat.walkTargetX));
    cat.walkTargetY = getBottomY(cat);
  }

  function setupCanvasSize() {
    dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    for (const cat of cats) {
      clampPos(cat);
    }
  }

  function setAnim(cat, name, flip) {
    if (name !== cat.currentAnim) {
      cat.currentAnim = name;
      cat.frameIndex = 0;
      cat.frameAccum = 0;
    }
    // Many sprite sheets have directional rows (walk/run/attack/hurt) drawn facing
    // the opposite of our expected default; invert horizontal mirroring for those.
    const isMirrored = typeof name === 'string' && /^(walk_?|run|attack|hurt)/.test(name);
    cat.flipSprite = isMirrored ? !flip : !!flip;
  }

  function advanceAnim(cat, dt) {
    const anim = getAnimDef(cat, cat.currentAnim);
    if (!anim) return;
    const frames = Math.max(1, anim.frames | 0);
    const fps = anim.fps > 0 ? anim.fps : 8;
    cat.frameAccum += dt;
    const step = 1 / fps;
    while (cat.frameAccum >= step) {
      cat.frameAccum -= step;
      cat.frameIndex = (cat.frameIndex + 1) % frames;
    }
  }

  function renderCat(cat) {
    if (!cat.spriteSource || !cat.manifest) return;
    const anim = getAnimDef(cat, cat.currentAnim);
    if (!anim) return;

    const { w: destW, h: destH, fw, fh } = getDrawSize(cat);
    const row = anim.row;
    const sxi = cat.frameIndex * fw;
    const syi = row * fh;

    if (cat.flipSprite) {
      ctx.save();
      ctx.translate(cat.x + destW, cat.y);
      ctx.scale(-1, 1);
      ctx.drawImage(cat.spriteSource, sxi, syi, fw, fh, 0, 0, destW, destH);
      ctx.restore();
    } else {
      ctx.drawImage(cat.spriteSource, sxi, syi, fw, fh, cat.x, cat.y, destW, destH);
    }
  }

  /**
   * @param {object} [opts]
   * @param {string | null} [opts.windowId] — front window key; used when focus changes to drop these cats.
   * @param {boolean} [opts.stableTie] — if true, cat stays on the title bar until that window is no longer front.
   */
  function sendCatToPerch(cat, b, ts, opts) {
    if (!PERCH_ON_OTHER_WINDOWS) return false;
    if (!cat || !b) return false;
    if (cat.finished) return false;
    if (cat.state !== 'idle' && cat.state !== 'walk') return false;
    const windowId = opts && opts.windowId != null ? opts.windowId : null;
    const stableTie = !!(opts && opts.stableTie);
    if (stableTie && windowId != null && cat.perchWindowId === windowId) {
      if (cat.state === 'walkToPerch' || cat.state === 'climbUp' || cat.state === 'perched') return false;
    }
    const { w } = getDrawSize(cat);
    if (b.right - b.left < Math.max(PERCH_MIN_WIDTH, w + 2 * MARGIN)) return false;
    const minX = MARGIN;
    const maxX = Math.max(MARGIN, canvas.clientWidth - MARGIN - w);
    const minLanding = Math.max(minX, b.left + MARGIN);
    const maxLanding = Math.min(maxX, b.right - MARGIN - w);
    if (minLanding > maxLanding) return false;
    cat.perch = { left: b.left, right: b.right, top: b.top };
    cat.perchWindowId = windowId;
    cat.perchTiedToStableWindow = stableTie;
    const landingX = rand(minLanding, maxLanding);
    cat.walkTargetX = landingX;
    cat.walkTargetY = getBottomY(cat);
    cat.sprinting = false;
    cat.state = 'walkToPerch';
    cat.canInteractAt = ts + INTERACT_BLOCK_MAX;
    return true;
  }

  /** Send a finished cat up onto the active window so it can display its finished bubble again. */
  function startFinishReshow(cat, bounds, ts, windowId) {
    if (!cat || !cat.finished || cat.finishReshowing) return false;
    if (!bounds) return false;
    const { w } = getDrawSize(cat);
    const minX = MARGIN;
    const maxX = Math.max(MARGIN, canvas.clientWidth - MARGIN - w);
    const minLanding = Math.max(minX, bounds.left + MARGIN);
    const maxLanding = Math.min(maxX, bounds.right - MARGIN - w);
    if (minLanding > maxLanding) return false;
    if (bounds.right - bounds.left < Math.max(PERCH_MIN_WIDTH, w + 2 * MARGIN)) return false;
    destroyFinishBubble(cat);
    cat.finished = false;
    cat.finishing = false;
    cat.finishReshowing = true;
    cat.perch = { left: bounds.left, right: bounds.right, top: bounds.top };
    cat.perchWindowId = windowId != null ? windowId : null;
    cat.perchTiedToStableWindow = false;
    cat.walkTargetX = rand(minLanding, maxLanding);
    cat.walkTargetY = getBottomY(cat);
    cat.sprinting = true;
    cat.state = 'walkToPerch';
    cat.canInteractAt = ts + INTERACT_BLOCK_MAX;
    cat.idleEndAt = ts + rand(1000, 3000);
    return true;
  }

  /** Every FINISH_RESHOW_INTERVAL_MS, finished cats jump back up to the active window and reshow their message. */
  function maybeStartFinishReshow(cat, ts) {
    if (!PERCH_ON_OTHER_WINDOWS) return;
    if (!cat.finished || cat.finishReshowing || cat.finishReshowPending) return;
    if (cat.finishedAt == null) return;
    if (ts - cat.finishedAt < FINISH_RESHOW_INTERVAL_MS) return;
    if (ts < (cat.nextFinishReshowAttemptAt || 0)) return;
    if (!window.cursorcats || typeof window.cursorcats.getFrontmostWindowBounds !== 'function') return;
    cat.finishReshowPending = true;
    cat.nextFinishReshowAttemptAt = ts + FINISH_RESHOW_RETRY_MS;
    window.cursorcats
      .getFrontmostWindowInfo()
      .then((info) => {
        cat.finishReshowPending = false;
        if (!cat.finished) return;
        const b = info && info.bounds;
        if (!b) return;
        const started = startFinishReshow(cat, b, performance.now(), info.id);
        if (started) {
          // Reset the clock so the next reshow fires FINISH_RESHOW_INTERVAL_MS
          // after the cat settles back on the floor (finishedAt stamp).
          cat.nextFinishReshowAttemptAt = 0;
        }
      })
      .catch(() => {
        cat.finishReshowPending = false;
      });
  }

  async function maybeRequestPerch(cat, ts) {
    if (!PERCH_ON_OTHER_WINDOWS) return;
    if (cat.finished) return;
    if (Math.random() >= PERCH_CHANCE_PER_IDLE) return;
    if (!window.cursorcats || typeof window.cursorcats.getFrontmostWindowInfo !== 'function') return;
    try {
      if (cat.state !== 'idle') return;
      const info = await window.cursorcats.getFrontmostWindowInfo();
      if (cat.state !== 'idle') return;
      const b = info && info.bounds;
      if (!b) return;
      sendCatToPerch(cat, b, ts, { windowId: info.id, stableTie: false });
    } catch {
      // ignore
    }
  }

  function fallCatsForPreviousFrontWindow(prevWindowId, ts) {
    if (prevWindowId == null) return;
    const t = ts != null ? ts : performance.now();
    for (const cat of cats) {
      if (cat.perchWindowId !== prevWindowId) continue;
      if (cat.state === 'climbUp') {
        cat.climb = null;
      } else if (cat.state !== 'perched' && cat.state !== 'walkToPerch') {
        continue;
      }
      startPerchFreeFall(cat, t);
    }
  }

  function batchSendFloorCatsToStablePerch(bounds, windowId, ts) {
    if (!bounds || windowId == null) return;
    for (const cat of cats) {
      if (cat.finished || cat.finishReshowing) continue;
      if (cat.state === 'interact') continue;
      if (cat.state === 'fallOff') continue;
      if (cat.state === 'perched' && cat.perchTiedToStableWindow && cat.perchWindowId === windowId) {
        continue;
      }
      if (
        (cat.state === 'idle' || cat.state === 'walk') &&
        !cat.perch &&
        !cat.finishReshowing
      ) {
        sendCatToPerch(cat, bounds, ts, { windowId, stableTie: true });
      }
    }
  }

  async function pollStableFrontWindow() {
    if (!PERCH_ON_OTHER_WINDOWS) return;
    if (!window.cursorcats || typeof window.cursorcats.getFrontmostWindowInfo !== 'function') return;
    try {
      const info = await window.cursorcats.getFrontmostWindowInfo();
      const id = info && info.id != null ? info.id : null;
      const bounds = info && info.bounds;
      const ts = performance.now();
      if (trackedFrontWindowId !== id) {
        const prev = trackedFrontWindowId;
        trackedFrontWindowId = id;
        if (prev != null) {
          fallCatsForPreviousFrontWindow(prev, ts);
        }
      }
      if (id && bounds && info.stableMs >= STABLE_THRESHOLD_MS) {
        batchSendFloorCatsToStablePerch(bounds, id, ts);
      }
    } catch {
      // ignore
    }
  }

  function startStabilityNudgeLoop() {
    if (stabilityNudgeTimer) return;
    void pollStableFrontWindow();
    stabilityNudgeTimer = setInterval(() => {
      void pollStableFrontWindow();
    }, FRONT_WINDOW_POLL_MS);
  }

  function startPerchEdgeFall(cat, side, ts) {
    cat.state = 'fallOff';
    cat.fall = { vy: 0, vx: side === 'right' ? FALL_MAX_VX : -FALL_MAX_VX };
    cat.perchLeaving = false;
    cat.perch = null;
    cat.perchWindowId = null;
    cat.perchTiedToStableWindow = false;
    cat.perchSub = 'idle';
    cat.sprinting = false;
    cat.canInteractAt = (ts != null ? ts : performance.now()) + INTERACT_BLOCK_MAX;
  }

  function startPerchFreeFall(cat, ts) {
    cat.state = 'fallOff';
    cat.fall = { vy: 0, vx: rand(-FALL_MAX_VX * 0.4, FALL_MAX_VX * 0.4) };
    cat.perchLeaving = false;
    cat.perch = null;
    cat.perchWindowId = null;
    cat.perchTiedToStableWindow = false;
    cat.perchSub = 'idle';
    cat.sprinting = false;
    cat.canInteractAt = ts + INTERACT_BLOCK_MAX;
  }

  function runWalkFrame(cat, dt) {
    const dx = cat.walkTargetX - cat.x;
    const dist = Math.abs(dx) || 1e-6;
    const speed = cat.sprinting ? SPRINT_SPEED : WALK_SPEED;
    const move = speed * dt;
    if (dist < 0.5 || move >= dist) {
      cat.x = cat.walkTargetX;
      return true;
    }
    const dir = dx > 0 ? 1 : -1;
    cat.x += dir * move;
    return false;
  }

  function playWalkAnims(cat, dt) {
    cat.facingRight = cat.walkTargetX >= cat.x;
    const wk = pickMoveAnim(cat, cat.facingRight);
    if (getAnimDef(cat, wk.key)) {
      setAnim(cat, wk.key, wk.flip);
      advanceAnim(cat, dt);
    } else {
      setAnim(cat, 'idle', false);
      advanceAnim(cat, dt);
    }
  }

  function updateCat(cat, dt, ts) {
    if (!cat.spriteSource || !cat.manifest) return;
    if (
      cat.finished &&
      !cat.finishReshowing &&
      (cat.state === 'idle' || cat.state === 'walk') &&
      !cat.perch
    ) {
      maybeStartFinishReshow(cat, ts);
    }
    if (cat.state === 'fallOff' && cat.fall) {
      const ax = (cat.fall.vx || 0) * dt;
      const ay = cat.fall.vy * dt;
      cat.fall.vy = (cat.fall.vy || 0) + FALL_GRAVITY * dt;
      cat.x += ax;
      cat.y += ay;
      if (getAnimDef(cat, 'jump')) setAnim(cat, 'jump', false);
      else setAnim(cat, 'idle', false);
      advanceAnim(cat, dt);
      const floorY = getBottomY(cat);
      if (cat.y >= floorY) {
        cat.y = floorY;
        cat.sprinting = false;
        cat.fall = null;
        cat.perch = null;
        cat.perchWindowId = null;
        cat.perchTiedToStableWindow = false;
        cat.perchLeaving = false;
        cat.perchSub = 'idle';
        cat.state = 'idle';
        cat.canInteractAt = 0;
        cat.idleEndAt = ts + rand(1000, 3000);
        const { w } = getDrawSize(cat);
        const min = MARGIN;
        const max = Math.max(MARGIN, canvas.clientWidth - MARGIN - w);
        cat.x = Math.min(max, Math.max(min, cat.x));
        if (cat.finishReshowing) {
          cat.finishReshowing = false;
          destroyFinishBubble(cat);
          cat.finished = true;
          cat.finishing = false;
          cat.state = 'idle';
          cat.sprinting = false;
          cat.idleEndAt = ts + rand(1000, 3000);
          cat.finishedAt = ts;
          cat.nextFinishReshowAttemptAt = ts + FINISH_RESHOW_INTERVAL_MS;
          cat.canInteractAt = ts + INTERACT_BLOCK_MAX;
        }
      }
      return;
    }
    if (cat.state === 'climbUp' && cat.climb) {
      const c = cat.climb;
      c.t = (c.t || 0) + dt;
      const p = Math.min(1, c.t / c.stepDur);
      const pe = easeClimbStep(p);
      const dx = c.x1 - c.x0;
      const dy = c.y1 - c.y0;
      cat.x = c.x0 + dx * pe;
      cat.y = c.y0 + dy * pe - 4 * pe * (1 - pe) * STAGGER_STEP_LIFT;
      if (dx > 0.01) cat.facingRight = true;
      else if (dx < -0.01) cat.facingRight = false;
      if (getAnimDef(cat, 'jump')) {
        setAnim(cat, 'jump', cat.facingRight);
      } else if (getAnimDef(cat, 'running_jump')) {
        setAnim(cat, 'running_jump', !cat.facingRight);
      } else {
        setAnim(cat, 'idle', !cat.facingRight);
      }
      advanceAnim(cat, dt);
      if (p >= 1) {
        cat.x = c.x1;
        cat.y = c.y1;
        const nextIdx = c.stepIdx + 1;
        if (nextIdx >= c.stepCount) {
          cat.x = c.xLanding;
          cat.y = Math.max(0, c.yTop);
          cat.climb = null;
          cat.state = 'perched';
          cat.perchSub = 'idle';
          cat.perchLeaving = false;
          cat.perchCheckPending = false;
          cat.idleEndAt = ts + rand(1000, 3000);
          if (cat.finishReshowing) {
            cat.perchUntil = ts + rand(FINISH_RESHOW_PERCH_MIN_MS, FINISH_RESHOW_PERCH_MAX_MS);
            // Keep reshowing cats idle so the bubble stays centered above them.
            cat.idleEndAt = cat.perchUntil + 1;
            cat.finishBubbleText =
              FINISH_BUBBLE_MESSAGES[
                Math.floor(Math.random() * FINISH_BUBBLE_MESSAGES.length)
              ];
            ensureFinishBubbleDom(cat);
          } else if (cat.perchTiedToStableWindow) {
            cat.perchUntil = ts + 365 * 24 * 60 * 60 * 1000;
          } else {
            cat.perchUntil = ts + rand(PERCH_DURATION_MIN, PERCH_DURATION_MAX);
          }
          cat.lastPerchQueryAt = ts;
          cat.canInteractAt = ts + INTERACT_BLOCK_MAX;
          return;
        }
        const t0 = nextIdx / c.stepCount;
        const t1 = (nextIdx + 1) / c.stepCount;
        const y0 = c.yGround + (c.yTop - c.yGround) * t0;
        const y1 = c.yGround + (c.yTop - c.yGround) * t1;
        const sign = nextIdx % 2 === 0 ? 1 : -1;
        const x0 = cat.x;
        const x1 =
          nextIdx === c.stepCount - 1
            ? c.xLanding
            : c.xLanding + sign * STAGGER_OFFSET;
        c.stepIdx = nextIdx;
        c.t = 0;
        c.x0 = x0;
        c.y0 = y0;
        c.x1 = x1;
        c.y1 = y1;
      }
      return;
    }
    if (cat.state === 'perched' && cat.perch) {
      if (cat.perchLeaving) {
        runWalkFrame(cat, dt);
        playWalkAnims(cat, dt);
        cat.y = getBaselineY(cat);
        const wOff = getDrawSize(cat).w;
        if (cat.x + wOff < cat.perch.left) {
          startPerchEdgeFall(cat, 'left', ts);
          return;
        }
        if (cat.x > cat.perch.right) {
          startPerchEdgeFall(cat, 'right', ts);
          return;
        }
        return;
      }
      if (!cat.perchCheckPending && ts - cat.lastPerchQueryAt >= PERCH_REQUERY_MS) {
        cat.lastPerchQueryAt = ts;
        cat.perchCheckPending = true;
        const p0 = { left: cat.perch.left, right: cat.perch.right, top: cat.perch.top };
        if (window.cursorcats && typeof window.cursorcats.getFrontmostWindowBounds === 'function') {
          window.cursorcats
            .getFrontmostWindowBounds()
            .then((b) => {
              cat.perchCheckPending = false;
              if (cat.state !== 'perched' || !cat.perch) return;
              if (!b) {
                startPerchFreeFall(cat, performance.now());
                return;
              }
              if (
                Math.abs(b.left - p0.left) > PERCH_BOUNDS_DRIFT ||
                Math.abs(b.top - p0.top) > PERCH_BOUNDS_DRIFT ||
                Math.abs(b.right - p0.right) > PERCH_BOUNDS_DRIFT
              ) {
                startPerchFreeFall(cat, performance.now());
                return;
              }
              cat.perch = { left: b.left, right: b.right, top: b.top };
              clampPos(cat);
            })
            .catch(() => {
              cat.perchCheckPending = false;
              if (cat.state === 'perched') startPerchFreeFall(cat, performance.now());
            });
        } else {
          cat.perchCheckPending = false;
        }
      }
      if (!cat.perchTiedToStableWindow && ts >= cat.perchUntil) {
        cat.perchLeaving = true;
        cat.perchSub = 'walk';
        const { w: pw } = getDrawSize(cat);
        const cx = cat.x + pw / 2;
        const midP = (cat.perch.left + cat.perch.right) / 2;
        if (cx < midP) {
          cat.walkTargetX = cat.perch.left - pw - 12;
        } else {
          cat.walkTargetX = cat.perch.right + 12;
        }
        return;
      }
      if (cat.perchSub === 'idle' || !cat.perchSub) {
        cat.y = getBaselineY(cat);
        if (getAnimDef(cat, 'idle')) {
          setAnim(cat, 'idle', false);
          advanceAnim(cat, dt);
        }
        if (ts >= cat.idleEndAt) {
          cat.perchSub = 'walk';
          if (!cat.perchLeaving) pickNewWalkTarget(cat);
          maybeStartSprint(cat);
        }
      } else {
        const atDest = runWalkFrame(cat, dt);
        if (atDest) {
          cat.sprinting = false;
          cat.perchSub = 'idle';
          cat.idleEndAt = ts + rand(1000, 3000);
        } else {
          playWalkAnims(cat, dt);
        }
        cat.y = getBaselineY(cat);
        clampPos(cat);
      }
      return;
    }
    if (cat.state === 'walkToPerch' && cat.perch) {
      if (runWalkFrame(cat, dt)) {
        cat.sprinting = false;
        const { h } = getDrawSize(cat);
        const yGround = getBottomY(cat);
        const yTop = Math.max(0, cat.perch.top - h);
        const xLanding = cat.x;
        const t1 = 1 / STAGGER_STEPS;
        const y0 = yGround;
        const y1 = yGround + (yTop - yGround) * t1;
        const sign = 1;
        const x1 =
          STAGGER_STEPS === 1 ? xLanding : xLanding + sign * STAGGER_OFFSET;
        cat.climb = {
          stepIdx: 0,
          stepCount: STAGGER_STEPS,
          t: 0,
          stepDur: STAGGER_STEP_MS / 1000,
          xLanding,
          yGround,
          yTop,
          x0: xLanding,
          y0,
          x1,
          y1,
        };
        cat.state = 'climbUp';
        return;
      }
      playWalkAnims(cat, dt);
      cat.y = getBottomY(cat);
      clampPos(cat);
      return;
    }
    if (cat.state === 'idle') {
      cat.y = getBottomY(cat);
      if (getAnimDef(cat, 'idle')) {
        setAnim(cat, 'idle', false);
        advanceAnim(cat, dt);
      }
      if (ts >= cat.idleEndAt) {
        cat.state = 'walk';
        const lockedSprint = cat.sprinting;
        if (!lockedSprint) pickNewWalkTarget(cat);
        if (!lockedSprint) maybeStartSprint(cat);
      }
    } else if (cat.state === 'interact') {
      cat.y = getBottomY(cat);
      const partner = cat.interactPartner;
      if (!partner || partner.state !== 'interact' || partner.interactPartner !== cat) {
        cat.state = 'walk';
        pickNewWalkTarget(cat);
        maybeStartSprint(cat);
        return;
      }
      if (ts >= cat.interactEndAt) {
        if (cats.indexOf(cat) < cats.indexOf(partner)) {
          finishInteractionPair(cat, partner, ts);
        }
        return;
      }
      faceEachOther(cat, partner);
      const flip = !cat.facingRight;
      if (cat.interactKind === 'fight') {
        if (cat.interactRole === 'attacker') {
          const name = getAnimDef(cat, 'attack') ? 'attack' : 'idle';
          setAnim(cat, name, flip);
        } else {
          const name = getAnimDef(cat, 'hurt') ? 'hurt' : 'idle';
          setAnim(cat, name, flip);
        }
        advanceAnim(cat, dt);
      } else if (cat.interactKind === 'greet') {
        if (getAnimDef(cat, 'idle')) {
          setAnim(cat, 'idle', flip);
        }
        advanceAnim(cat, dt);
      }
      clampPos(cat);
    } else if (cat.state === 'walk') {
      cat.y = getBottomY(cat);
      if (runWalkFrame(cat, dt)) {
        cat.sprinting = false;
        cat.state = 'idle';
        cat.idleEndAt = ts + rand(1000, 3000);
        void maybeRequestPerch(cat, ts);
      } else {
        playWalkAnims(cat, dt);
      }
      clampPos(cat);
    } else {
      cat.y = getBottomY(cat);
    }
  }

  function pickCatAt(clientX, clientY) {
    for (let i = cats.length - 1; i >= 0; i--) {
      const cat = cats[i];
      if (!cat.catId) continue;
      const r = getHitboxRect(cat);
      if (
        clientX >= r.x &&
        clientX <= r.x + r.w &&
        clientY >= r.y &&
        clientY <= r.y + r.h
      ) {
        return cat;
      }
    }
    return null;
  }

  function postCatScreenRects() {
    if (!window.cursorcats || typeof window.cursorcats.postCatScreenRects !== 'function') return;
    const wx = window.screenX ?? window.screenLeft ?? 0;
    const wy = window.screenY ?? window.screenTop ?? 0;
    const rects = [];
    for (const cat of cats) {
      if (!cat.catId) continue;
      const r = getHitboxRect(cat);
      rects.push({
        left: wx + r.x,
        top: wy + r.y,
        right: wx + r.x + r.w,
        bottom: wy + r.y + r.h,
      });
    }
    window.cursorcats.postCatScreenRects(rects);
  }

  function gameLoop(ts) {
    if (!lastFrameTime) lastFrameTime = ts;
    const dt = Math.min(0.1, (ts - lastFrameTime) / 1000);
    lastFrameTime = ts;

    tryResolveCollisions(ts);

    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (const cat of cats) {
      updateCat(cat, dt, ts);
      renderCat(cat);
    }
    syncFinishBubbles();
    syncStreamBubbles();
    postCatScreenRects();
    requestAnimationFrame(gameLoop);
  }

  window.addEventListener('resize', () => {
    setupCanvasSize();
  });

  /** Load and cache the sprite manifest + image for a given `assets/cats/`-relative path. */
  async function loadCatAssets(manifestRel) {
    if (assetCache.has(manifestRel)) return assetCache.get(manifestRel);
    const text = await window.cursorcats.readTextFile(`assets/cats/${manifestRel}`);
    const manifest = JSON.parse(text);
    if (!manifest || !manifest.image) {
      throw new Error(`Manifest missing image: ${manifestRel}`);
    }
    const imageRel = resolveCatImagePath(manifestRel, manifest.image);
    const url = await window.cursorcats.getAssetFileUrl(imageRel);
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    const hitbox = computeVisibleHitbox(img, manifest);
    const entry = { manifest, img, hitbox };
    assetCache.set(manifestRel, entry);
    return entry;
  }

  /**
   * After a global hue-rotate, very light sclera / eye highlights pick up pink-red hues.
   * Pixels that were already bright and nearly neutral in the source are copied back unchanged.
   */
  function shouldPreserveNeutralBrightPixel(r, g, b) {
    const sum = r + g + b;
    if (sum < 500) return false;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const spread = max - min;
    const avg = sum / 3;
    if (avg > 218 && spread < 42) return true;
    if (max > 232 && min > 175 && spread < 115) return true;
    return false;
  }

  function restoreNeutralBrightPixelsFromSource(destCanvas, sourceImage) {
    const w = destCanvas.width;
    const h = destCanvas.height;
    if (!w || !h) return;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(sourceImage, 0, 0);
    const orig = tctx.getImageData(0, 0, w, h);
    const dctx = destCanvas.getContext('2d');
    const out = dctx.getImageData(0, 0, w, h);
    const o = orig.data;
    const d = out.data;
    for (let i = 0; i < o.length; i += 4) {
      const a = o[i + 3];
      if (a < 8) continue;
      const r = o[i];
      const g = o[i + 1];
      const b = o[i + 2];
      if (shouldPreserveNeutralBrightPixel(r, g, b)) {
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
        d[i + 3] = a;
      }
    }
    dctx.putImageData(out, 0, 0);
  }

  /** One-time hue-rotate of the sprite sheet into an offscreen canvas (Chromium/Electron). */
  function buildHueSprite(im) {
    const hue = Math.floor(Math.random() * 360);
    const off = document.createElement('canvas');
    off.width = im.naturalWidth;
    off.height = im.naturalHeight;
    const octx = off.getContext('2d');
    octx.imageSmoothingEnabled = false;
    octx.filter = `hue-rotate(${hue}deg)`;
    octx.drawImage(im, 0, 0);
    octx.filter = 'none';
    restoreNeutralBrightPixelsFromSource(off, im);
    return off;
  }

  function makeCat(manifest, spriteSource, meta, hitbox) {
    const folder = meta && typeof meta.folder === 'string' ? meta.folder : '';
    const prompt = meta && typeof meta.prompt === 'string' ? meta.prompt : '';
    const catId = meta && meta.catId != null ? String(meta.catId) : null;
    const fw = (manifest && manifest.frameWidth) || 32;
    const fh = (manifest && manifest.frameHeight) || 32;
    const hb =
      hitbox && typeof hitbox.w === 'number' && typeof hitbox.h === 'number'
        ? hitbox
        : { x: 0, y: 0, w: fw, h: fh };
    const cat = {
      manifest,
      spriteSource,
      hitbox: hb,
      folder,
      prompt,
      catId,
      /** 'sdk' | 'ide' */
      kind: (meta && meta.kind) || 'sdk',
      finished: false,
      finishing: false,
      finishedOrder: null,
      endStatus: null,
      endResult: null,
      x: 0,
      y: 0,
      state: 'idle',
      idleEndAt: 0,
      walkTargetX: 0,
      walkTargetY: 0,
      facingRight: true,
      currentAnim: 'idle',
      frameIndex: 0,
      frameAccum: 0,
      flipSprite: false,
      interactKind: null,
      interactRole: null,
      interactPartner: null,
      interactEndAt: 0,
      canInteractAt: 0,
      sprinting: false,
      perch: null,
      perchSub: 'idle',
      perchUntil: 0,
      lastPerchQueryAt: 0,
      perchCheckPending: false,
      perchLeaving: false,
      perchWindowId: null,
      perchTiedToStableWindow: false,
      climb: null,
      fall: null,
      finishBubbleEl: null,
      finishBubbleText: null,
      finishedAt: null,
      finishReshowing: false,
      finishReshowPending: false,
      nextFinishReshowAttemptAt: 0,
      /** @type {ReturnType<typeof setTimeout> | null} */
      ideRemovalTimer: null,
      /** @type {ReturnType<typeof setTimeout> | null} */
      finishBubbleHideTimer: null,
      streamBubbleEl: null,
      streamBubbleText: null,
      /** @type {ReturnType<typeof setTimeout> | null} */
      streamBubbleHideTimer: null,
    };
    const { max } = getHorizontalRange(cat);
    cat.x = max;
    cat.y = getBottomY(cat);
    cat.facingRight = false;
    cat.idleEndAt = performance.now() + rand(1000, 3000);
    return cat;
  }

  /** After IDE session ends, dismiss the overlay cat this long after showing the finished state. */
  const IDE_FINISH_REMOVE_MS = 10000;

  function clearIdeRemovalTimer(cat) {
    if (!cat || !cat.ideRemovalTimer) return;
    clearTimeout(cat.ideRemovalTimer);
    cat.ideRemovalTimer = null;
  }

  /** Schedule remove via main `dismissCat` → `removeIdeCatIfPresent` after the finish animation + bubble. */
  function scheduleIdeCatRemoval(cat) {
    if (!cat || cat.kind !== 'ide' || !cat.catId) return;
    clearIdeRemovalTimer(cat);
    cat.ideRemovalTimer = setTimeout(() => {
      cat.ideRemovalTimer = null;
      const id = cat.catId != null ? String(cat.catId) : '';
      if (!id || !window.cursorcats || typeof window.cursorcats.dismissCat !== 'function') return;
      const still = cats.find((c) => c.catId != null && String(c.catId) === id);
      if (!still) return;
      window.cursorcats.dismissCat(id);
    }, IDE_FINISH_REMOVE_MS);
  }

  function clearFinishBubbleHideTimer(cat) {
    if (!cat || !cat.finishBubbleHideTimer) return;
    clearTimeout(cat.finishBubbleHideTimer);
    cat.finishBubbleHideTimer = null;
  }

  /** Hides the on-cat text bubble; the cat can still be `finished` / in review. */
  function hideFinishBubbleVisually(cat) {
    if (!cat) return;
    const el = cat.finishBubbleEl;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    cat.finishBubbleEl = null;
    cat.finishBubbleText = null;
  }

  function scheduleFinishBubbleAutoHide(cat) {
    if (!cat) return;
    clearFinishBubbleHideTimer(cat);
    cat.finishBubbleHideTimer = setTimeout(() => {
      cat.finishBubbleHideTimer = null;
      if (!cats.includes(cat)) return;
      hideFinishBubbleVisually(cat);
    }, FINISH_BUBBLE_MS);
  }

  function destroyFinishBubble(cat) {
    if (!cat) return;
    clearFinishBubbleHideTimer(cat);
    hideFinishBubbleVisually(cat);
  }

  function clearStreamBubbleHideTimer(cat) {
    if (!cat || !cat.streamBubbleHideTimer) return;
    clearTimeout(cat.streamBubbleHideTimer);
    cat.streamBubbleHideTimer = null;
  }

  function hideStreamBubbleVisually(cat) {
    if (!cat) return;
    const el = cat.streamBubbleEl;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    cat.streamBubbleEl = null;
    cat.streamBubbleText = null;
  }

  function scheduleStreamBubbleAutoHide(cat) {
    if (!cat) return;
    clearStreamBubbleHideTimer(cat);
    cat.streamBubbleHideTimer = setTimeout(() => {
      cat.streamBubbleHideTimer = null;
      if (!cats.includes(cat)) return;
      hideStreamBubbleVisually(cat);
    }, STREAM_BUBBLE_MS);
  }

  function destroyStreamBubble(cat) {
    if (!cat) return;
    clearStreamBubbleHideTimer(cat);
    hideStreamBubbleVisually(cat);
  }

  function ensureStreamBubbleDom(cat) {
    if (!bubbleLayer || !cat || cat.finished || !cat.streamBubbleText) return;
    if (!cat.streamBubbleEl) {
      const el = document.createElement('div');
      el.className = 'cat-stream-bubble';
      bubbleLayer.appendChild(el);
      cat.streamBubbleEl = el;
    }
    cat.streamBubbleEl.textContent = cat.streamBubbleText;
    scheduleStreamBubbleAutoHide(cat);
  }

  function applyAgentStreamBubble(ev) {
    if (!ev || ev.catId == null) return;
    const id = String(ev.catId);
    const text = ev.text != null ? String(ev.text).trim() : '';
    if (!text) return;
    const cat = cats.find((c) => c.catId != null && String(c.catId) === id);
    if (!cat || cat.finished) return;
    cat.streamBubbleText = text;
    ensureStreamBubbleDom(cat);
  }

  function syncStreamBubbles() {
    if (!bubbleLayer) return;
    for (const cat of cats) {
      if (cat.finished || !cat.streamBubbleEl) continue;
      const { w } = getDrawSize(cat);
      const cx = cat.x + w / 2;
      cat.streamBubbleEl.style.left = `${cx}px`;
      cat.streamBubbleEl.style.top = `${cat.y}px`;
    }
  }

  function ensureFinishBubbleDom(cat) {
    if (!bubbleLayer || !cat || (!cat.finished && !cat.finishReshowing) || !cat.finishBubbleText) return;
    if (!cat.finishBubbleEl) {
      const el = document.createElement('div');
      el.className = 'cat-finish-bubble';
      el.textContent = cat.finishBubbleText;
      bubbleLayer.appendChild(el);
      cat.finishBubbleEl = el;
    }
    scheduleFinishBubbleAutoHide(cat);
  }

  function syncFinishBubbles() {
    if (!bubbleLayer) return;
    for (const cat of cats) {
      if ((!cat.finished && !cat.finishReshowing) || !cat.finishBubbleEl) continue;
      const { w } = getDrawSize(cat);
      const cx = cat.x + w / 2;
      cat.finishBubbleEl.style.left = `${cx}px`;
      cat.finishBubbleEl.style.top = `${cat.y}px`;
    }
  }

  function detachPartnerIfInteracting(cat) {
    if (!cat) return;
    const partner = cat.interactPartner;
    if (partner && partner.interactPartner === cat) {
      partner.interactPartner = null;
      partner.interactKind = null;
      partner.interactRole = null;
      partner.interactEndAt = 0;
      if (!partner.finished) {
        partner.state = 'walk';
        pickNewWalkTarget(partner);
        maybeStartSprint(partner);
      }
    }
    cat.interactPartner = null;
    cat.interactKind = null;
    cat.interactRole = null;
    cat.interactEndAt = 0;
  }

  function applyAgentFinishToCat(cat, ev) {
    const status = ev && ev.status != null ? String(ev.status) : 'unknown';
    const endText =
      ev && ev.result != null && String(ev.result).length > 0
        ? String(ev.result)
        : ev && ev.endResult != null
          ? String(ev.endResult)
          : '';
    cat.endStatus = status;
    cat.endResult = endText;
    if (cat.finishedOrder == null) {
      cat.finishedOrder = nextFinishedOrder++;
    }
    cat.finishing = false;
    cat.finished = true;
    cat.finishReshowing = false;
    cat.finishReshowPending = false;
    const nowTs = performance.now();
    cat.finishedAt = nowTs;
    cat.nextFinishReshowAttemptAt = nowTs + FINISH_RESHOW_INTERVAL_MS;
    cat.perch = null;
    cat.perchLeaving = false;
    cat.perchSub = 'idle';
    cat.perchWindowId = null;
    cat.perchTiedToStableWindow = false;
    cat.climb = null;
    cat.fall = null;
    cat.y = getBottomY(cat);
    clampPos(cat);
    cat.state = 'idle';
    cat.sprinting = false;
    cat.idleEndAt = nowTs + rand(1000, 3000);
    cat.walkTargetX = cat.x;
    cat.walkTargetY = getBottomY(cat);
    cat.canInteractAt = nowTs + 4000;
    destroyStreamBubble(cat);
    destroyFinishBubble(cat);
    detachPartnerIfInteracting(cat);
    cat.finishBubbleText =
      FINISH_BUBBLE_MESSAGES[Math.floor(Math.random() * FINISH_BUBBLE_MESSAGES.length)];
    ensureFinishBubbleDom(cat);
    if (cat.kind === 'ide') {
      scheduleIdeCatRemoval(cat);
    }
  }

  function reactivateCat(catId) {
    if (catId == null) return;
    const id = String(catId);
    pendingFinishes.delete(id);
    const cat = cats.find((c) => c.catId != null && String(c.catId) === id);
    if (!cat) return;
    if (!cat.finished && !cat.finishing) return;
    destroyStreamBubble(cat);
    destroyFinishBubble(cat);
    detachPartnerIfInteracting(cat);
    cat.finished = false;
    cat.finishing = false;
    cat.finishedOrder = null;
    cat.endStatus = null;
    cat.endResult = null;
    cat.sprinting = false;
    cat.perch = null;
    cat.perchLeaving = false;
    cat.perchSub = 'idle';
    cat.perchWindowId = null;
    cat.perchTiedToStableWindow = false;
    cat.climb = null;
    cat.fall = null;
    cat.state = 'idle';
    cat.canInteractAt = 0;
    cat.finishedAt = null;
    cat.finishReshowing = false;
    cat.finishReshowPending = false;
    cat.nextFinishReshowAttemptAt = 0;
    clearIdeRemovalTimer(cat);
    const nowTs = performance.now();
    cat.idleEndAt = nowTs + rand(200, 600);
    cat.y = getBottomY(cat);
    clampPos(cat);
    reportCatCountsIfChanged();
  }

  function markAgentFinished(ev) {
    if (!ev || ev.catId == null) return;
    const id = String(ev.catId);
    const cat = cats.find((c) => c.catId != null && String(c.catId) === id);
    if (cat && cat.finished) return;
    if (!cat) {
      pendingFinishes.set(id, ev);
      return;
    }
    applyAgentFinishToCat(cat, ev);
    reportCatCountsIfChanged();
  }

  async function spawnCat(payload) {
    // eslint-disable-next-line no-console
    console.log('[cursorcats] spawnCat received', {
      catId: payload && payload.catId,
      kind: payload && payload.kind,
    });
    if (!window.cursorcats) return;
    try {
      if (!manifestPaths) manifestPaths = await readCatManifestPaths();
      const manifestRel = pickRandomManifest(manifestPaths);
      const { manifest, img, hitbox } = await loadCatAssets(manifestRel);
      const spriteSource = buildHueSprite(img);
      const cat = makeCat(manifest, spriteSource, payload, hitbox);
      cats.push(cat);
      if (cat.catId && pendingFinishes.has(String(cat.catId))) {
        const p = pendingFinishes.get(String(cat.catId));
        pendingFinishes.delete(String(cat.catId));
        if (p) {
          applyAgentFinishToCat(cat, p);
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[cursorcats] Failed to spawn cat', { payload, err: e });
    }
    reportCatCountsIfChanged();
  }

  async function boot() {
    setupCanvasSize();
    if (!window.cursorcats) {
      // eslint-disable-next-line no-console
      console.error('cursorcats API missing (preload not loaded?)');
    } else {
      if (typeof window.cursorcats.onSpawnCat === 'function') {
        window.cursorcats.onSpawnCat((p) => {
          spawnCat(p);
        });
      }
      if (typeof window.cursorcats.onAgentFinished === 'function') {
        window.cursorcats.onAgentFinished((ev) => {
          markAgentFinished(ev);
        });
      }
      if (typeof window.cursorcats.onAgentStreamBubble === 'function') {
        window.cursorcats.onAgentStreamBubble((ev) => {
          applyAgentStreamBubble(ev);
        });
      }
      if (typeof window.cursorcats.onAgentRestarted === 'function') {
        window.cursorcats.onAgentRestarted((ev) => {
          if (ev && ev.catId != null) reactivateCat(ev.catId);
        });
      }
      if (typeof window.cursorcats.onRemoveCat === 'function') {
        window.cursorcats.onRemoveCat((payload) => {
          if (!payload || payload.catId == null) return;
          const rid = String(payload.catId);
          pendingFinishes.delete(rid);
          const idx = cats.findIndex((c) => c.catId != null && String(c.catId) === rid);
          if (idx >= 0) {
            clearIdeRemovalTimer(cats[idx]);
            destroyStreamBubble(cats[idx]);
            destroyFinishBubble(cats[idx]);
            cats.splice(idx, 1);
            reportCatCountsIfChanged();
          }
        });
      }
      if (typeof window.cursorcats.onClearFinishedCats === 'function') {
        window.cursorcats.onClearFinishedCats(() => {
          const ids = cats
            .filter((c) => c.finished || c.finishReshowing)
            .map((c) => c.catId)
            .filter((id) => id != null)
            .map((id) => String(id));
          if (!window.cursorcats || typeof window.cursorcats.dismissCat !== 'function') return;
          for (const id of ids) {
            window.cursorcats.dismissCat(id);
          }
        });
      }
      if (PERCH_ON_OTHER_WINDOWS && typeof window.cursorcats.getFrontmostWindowInfo === 'function') {
        startStabilityNudgeLoop();
      }
      canvas.addEventListener('click', (e) => {
        const cat = pickCatAt(e.clientX, e.clientY);
        if (cat && cat.catId && typeof window.cursorcats.openCatConversation === 'function') {
          window.cursorcats.openCatConversation(cat.catId);
        }
      });
      canvas.addEventListener('mousemove', (e) => {
        const cat = pickCatAt(e.clientX, e.clientY);
        canvas.style.cursor = cat && cat.catId ? 'pointer' : 'default';
      });
      reportCatCountsIfChanged();
    }
    if (!rafStarted) {
      rafStarted = true;
      requestAnimationFrame(gameLoop);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
