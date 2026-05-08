"""Entry point for the `computer_use` tool.

Universal macOS desktop control via cua-driver's background computer-use
primitive. The schema is standard function-calling so every tool-capable model
can drive it.

Return contract
---------------
All results are JSON strings. Captures and capture_after responses include
human-readable AX/SOM text plus screenshot metadata. Screenshot bytes are saved
as local cache artifacts and returned by path; inline base64/data URLs are never
returned to the model or durable transcript. If visual analysis is needed, call
the existing vision_analyze tool with the returned screenshot_path.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from tools.computer_use.backend import (
    ActionResult,
    CaptureResult,
    ComputerUseBackend,
    UIElement,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Approval & safety
# ---------------------------------------------------------------------------

_approval_callback = None


def set_approval_callback(cb) -> None:
    """Register a callback for computer_use approval prompts (used by CLI).

    Matches the terminal_tool._approval_callback pattern. The callback
    receives (action, args, summary) and returns one of:
      "approve_once" | "approve_session" | "always_approve" | "deny".
    """
    global _approval_callback
    _approval_callback = cb


# Actions that read, not mutate. Always allowed.
_SAFE_ACTIONS = frozenset({
    "check_permissions",
    "capture",
    "screenshot",
    "wait",
    "list_apps",
    "list_windows",
    "screen_size",
    "cursor_position",
    "cursor_state",
})

# Actions that mutate user-visible state. Go through approval.
_DESTRUCTIVE_ACTIONS = frozenset({
    "click", "double_click", "right_click",
    "drag", "scroll", "set_value", "type", "type_chars", "key", "focus_app",
    "page", "zoom", "set_recording", "replay_trajectory",
    "set_cursor_enabled", "set_cursor_motion",
})

# Hard-blocked key combinations. These are destructive regardless of approval
# level (e.g. logout kills the session Hermes runs in).
_BLOCKED_KEY_COMBOS = {
    frozenset({"cmd", "shift", "backspace"}),   # empty trash
    frozenset({"cmd", "option", "backspace"}),   # force delete
    frozenset({"cmd", "ctrl", "q"}),             # lock screen
    frozenset({"cmd", "shift", "q"}),            # log out
    frozenset({"cmd", "option", "shift", "q"}),  # force log out
}

_KEY_ALIASES = {"command": "cmd", "control": "ctrl", "alt": "option", "⌘": "cmd", "⌥": "option"}


def _canon_key_combo(keys: str) -> frozenset:
    parts = [p.strip().lower() for p in re.split(r"\s*\+\s*", keys) if p.strip()]
    parts = [_KEY_ALIASES.get(p, p) for p in parts]
    return frozenset(parts)


# Dangerous text patterns for the `type` action.
_BLOCKED_TYPE_PATTERNS = [
    re.compile(r"curl\s+[^|]*\|\s*bash", re.IGNORECASE),
    re.compile(r"curl\s+[^|]*\|\s*sh", re.IGNORECASE),
    re.compile(r"wget\s+[^|]*\|\s*bash", re.IGNORECASE),
    re.compile(r"\bsudo\s+rm\s+-[rf]", re.IGNORECASE),
    re.compile(r"\brm\s+-rf\s+/\s*$", re.IGNORECASE),
    re.compile(r":\s*\(\)\s*\{\s*:\|:\s*&\s*\}", re.IGNORECASE),  # fork bomb
]


def _is_blocked_type(text: str) -> Optional[str]:
    for pat in _BLOCKED_TYPE_PATTERNS:
        if pat.search(text):
            return pat.pattern
    return None


# ---------------------------------------------------------------------------
# Backend selection — env-swappable for tests
# ---------------------------------------------------------------------------

# Per-process cached backend; lazily instantiated on first call.
_backend_lock = threading.Lock()
_backend: Optional[ComputerUseBackend] = None
# Session-scoped approval state.
_session_auto_approve = False
_always_allow: set = set()  # action names the user unlocked for the session


def _get_backend() -> ComputerUseBackend:
    global _backend
    with _backend_lock:
        if _backend is None:
            backend_name = os.environ.get("HERMES_COMPUTER_USE_BACKEND", "cua").lower()
            if backend_name in ("cua", "cua-driver", ""):
                from tools.computer_use.cua_backend import CuaDriverBackend
                _backend = CuaDriverBackend()
            elif backend_name == "noop":  # pragma: no cover
                _backend = _NoopBackend()
            else:
                raise RuntimeError(f"Unknown HERMES_COMPUTER_USE_BACKEND={backend_name!r}")
            _backend.start()
        return _backend


def reset_backend_for_tests() -> None:  # pragma: no cover
    """Test helper — tear down the cached backend."""
    global _backend, _session_auto_approve, _always_allow
    with _backend_lock:
        if _backend is not None:
            try:
                _backend.stop()
            except Exception:
                pass
        _backend = None
    _session_auto_approve = False
    _always_allow = set()


class _NoopBackend(ComputerUseBackend):  # pragma: no cover
    """Test/CI stub. Records calls; returns trivial results."""

    def __init__(self) -> None:
        self.calls: List[Tuple[str, Dict[str, Any]]] = []
        self._started = False

    def start(self) -> None: self._started = True
    def stop(self) -> None: self._started = False
    def is_available(self) -> bool: return True

    def capture(self, mode: str = "som", app: Optional[str] = None) -> CaptureResult:
        self.calls.append(("capture", {"mode": mode, "app": app}))
        return CaptureResult(mode=mode, width=1024, height=768, image_bytes=None,
                             elements=[], app=app or "", window_title="")

    def screenshot(self, **kw) -> CaptureResult:
        self.calls.append(("screenshot", kw))
        return CaptureResult(mode="screenshot", width=1024, height=768)

    def click(self, **kw) -> ActionResult:
        self.calls.append(("click", kw))
        return ActionResult(ok=True, action="click")

    def drag(self, **kw) -> ActionResult:
        self.calls.append(("drag", kw))
        return ActionResult(ok=True, action="drag")

    def scroll(self, **kw) -> ActionResult:
        self.calls.append(("scroll", kw))
        return ActionResult(ok=True, action="scroll")

    def type_text(self, text: str) -> ActionResult:
        self.calls.append(("type", {"text": text}))
        return ActionResult(ok=True, action="type")

    def type_text_chars(self, text: str, **kw) -> ActionResult:
        self.calls.append(("type_chars", {"text": text, **kw}))
        return ActionResult(ok=True, action="type_chars")

    def key(self, keys: str) -> ActionResult:
        self.calls.append(("key", {"keys": keys}))
        return ActionResult(ok=True, action="key")

    def set_value(self, **kw) -> ActionResult:
        self.calls.append(("set_value", kw))
        return ActionResult(ok=True, action="set_value")

    def check_permissions(self, prompt: bool = False) -> Dict[str, Any]:
        self.calls.append(("check_permissions", {"prompt": prompt}))
        return {"accessibility": "unknown", "screen_recording": "unknown"}

    def list_apps(self) -> List[Dict[str, Any]]:
        self.calls.append(("list_apps", {}))
        return []

    def list_windows(self, **kw) -> List[Dict[str, Any]]:
        self.calls.append(("list_windows", kw))
        return []

    def get_screen_size(self) -> Dict[str, Any]:
        self.calls.append(("screen_size", {}))
        return {"width": 1024, "height": 768}

    def get_cursor_position(self) -> Dict[str, Any]:
        self.calls.append(("cursor_position", {}))
        return {"x": 0, "y": 0}

    def get_cursor_state(self) -> Dict[str, Any]:
        self.calls.append(("cursor_state", {}))
        return {}

    def focus_app(self, app: str, raise_window: bool = False) -> ActionResult:
        self.calls.append(("focus_app", {"app": app, "raise": raise_window}))
        return ActionResult(ok=True, action="focus_app")

    def page(self, **kw) -> ActionResult:
        self.calls.append(("page", kw))
        return ActionResult(ok=True, action="page", meta=kw)

    def zoom(self, **kw) -> CaptureResult:
        self.calls.append(("zoom", kw))
        return CaptureResult(mode="zoom", width=512, height=512)

    def set_recording(self, **kw) -> ActionResult:
        self.calls.append(("set_recording", kw))
        return ActionResult(ok=True, action="set_recording")

    def replay_trajectory(self, **kw) -> ActionResult:
        self.calls.append(("replay_trajectory", kw))
        return ActionResult(ok=True, action="replay_trajectory")

    def set_cursor_enabled(self, enabled: bool) -> ActionResult:
        self.calls.append(("set_cursor_enabled", {"enabled": enabled}))
        return ActionResult(ok=True, action="set_cursor_enabled")

    def set_cursor_motion(self, settings: Dict[str, Any]) -> ActionResult:
        self.calls.append(("set_cursor_motion", settings))
        return ActionResult(ok=True, action="set_cursor_motion")


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

def handle_computer_use(args: Dict[str, Any], **kwargs) -> str:
    """Main entry point — dispatched by tools.registry.

    Returns JSON text. Screenshot bytes are persisted as local artifacts.
    """
    action = (args.get("action") or "").strip().lower()
    if not action:
        return json.dumps({"error": "missing `action`"})

    # Safety: validate actions before approval prompt.
    if action == "type":
        text = args.get("text", "")
        pat = _is_blocked_type(text)
        if pat:
            return json.dumps({
                "error": f"blocked pattern in type text: {pat!r}",
                "hint": "Dangerous shell patterns cannot be typed via computer_use.",
            })

    if action == "key":
        keys = args.get("keys", "")
        combo = _canon_key_combo(keys)
        for blocked in _BLOCKED_KEY_COMBOS:
            if blocked.issubset(combo) and len(blocked) <= len(combo):
                return json.dumps({
                    "error": f"blocked key combo: {sorted(blocked)}",
                    "hint": "Destructive system shortcuts are hard-blocked.",
                })

    # Approval gate (destructive actions only).
    if action == "check_permissions" and bool(args.get("prompt")):
        err = _request_approval(action, args)
        if err is not None:
            return err

    if action in _DESTRUCTIVE_ACTIONS:
        err = _request_approval(action, args)
        if err is not None:
            return err

    # Dispatch to backend.
    try:
        backend = _get_backend()
    except Exception as e:
        return json.dumps({
            "error": f"computer_use backend unavailable: {e}",
            "hint": "Run `hermes tools` and enable Computer Use to install cua-driver.",
        })

    try:
        return _dispatch(backend, action, args)
    except Exception as e:
        logger.exception("computer_use %s failed", action)
        return json.dumps({"error": f"{action} failed: {e}"})


def _request_approval(action: str, args: Dict[str, Any]) -> Optional[str]:
    """Return None if approved, or a JSON error string if denied."""
    global _session_auto_approve, _always_allow
    if _session_auto_approve:
        return None
    if action in _always_allow:
        return None
    cb = _approval_callback
    if cb is None:
        # No CLI approval wired — default allow. Gateway approval is handled
        # one layer out via the normal tool-approval infra.
        return None
    summary = _summarize_action(action, args)
    try:
        verdict = cb(action, args, summary)
    except Exception as e:
        logger.warning("approval callback failed: %s", e)
        verdict = "deny"
    if verdict == "approve_once":
        return None
    if verdict == "approve_session" or verdict == "always_approve":
        _always_allow.add(action)
        if verdict == "always_approve":
            _session_auto_approve = True
        return None
    return json.dumps({"error": "denied by user", "action": action})


def _summarize_action(action: str, args: Dict[str, Any]) -> str:
    if action in ("click", "double_click", "right_click"):
        if args.get("element") is not None:
            return f"{action} element #{args['element']}"
        coord = args.get("coordinate")
        if coord:
            return f"{action} at {tuple(coord)}"
        return action
    if action == "drag":
        src = args.get("from_coordinate")
        dst = args.get("to_coordinate")
        return f"drag {src} → {dst}"
    if action == "scroll":
        return f"scroll {args.get('direction', '?')} x{args.get('amount', 3)}"
    if action == "type":
        text = args.get("text", "")
        return f"type {text[:60]!r}" + ("..." if len(text) > 60 else "")
    if action == "key":
        return f"key {args.get('keys', '')!r}"
    if action == "focus_app":
        return f"focus {args.get('app', '')!r}" + (" (raise)" if args.get("raise_window") else "")
    return action


def _dispatch(backend: ComputerUseBackend, action: str, args: Dict[str, Any]) -> Any:
    capture_after = bool(args.get("capture_after"))

    if action == "check_permissions":
        return json.dumps({"permissions": backend.check_permissions(prompt=bool(args.get("prompt", False)))})

    if action == "capture":
        mode = str(args.get("mode", "som"))
        if mode not in ("som", "vision", "ax"):
            return json.dumps({"error": f"bad mode {mode!r}; use som|vision|ax"})
        cap = backend.capture(mode=mode, app=args.get("app"))
        return _capture_response(cap)

    if action == "screenshot":
        cap = backend.screenshot(
            window_id=_optional_int(args.get("window_id")),
            image_format=str(args.get("format", "png")),
            quality=_optional_int(args.get("quality")),
        )
        return _capture_response(cap)

    if action == "wait":
        seconds = float(args.get("seconds", 1.0))
        res = backend.wait(seconds)
        return _text_response(res)

    if action == "list_apps":
        apps = backend.list_apps()
        return json.dumps({"apps": apps, "count": len(apps)})

    if action == "list_windows":
        windows = backend.list_windows(
            app=args.get("app"),
            pid=_optional_int(args.get("pid")),
            on_screen_only=bool(args.get("on_screen_only", False)),
        )
        return json.dumps({"windows": windows, "count": len(windows)})

    if action == "screen_size":
        return json.dumps({"screen": backend.get_screen_size()})

    if action == "cursor_position":
        return json.dumps({"cursor": backend.get_cursor_position()})

    if action == "cursor_state":
        return json.dumps({"cursor": backend.get_cursor_state()})

    if action == "focus_app":
        app = args.get("app")
        if not app:
            return json.dumps({"error": "focus_app requires `app`"})
        res = backend.focus_app(app, raise_window=bool(args.get("raise_window")))
        return _maybe_follow_capture(backend, res, capture_after)

    if action in ("click", "double_click", "right_click"):
        button = args.get("button")
        click_count = 1
        if action == "double_click":
            click_count = 2
        elif action == "right_click":
            button = "right"
        else:
            button = button or "left"
        element = args.get("element")
        coord = args.get("coordinate") or (None, None)
        x, y = (coord[0], coord[1]) if coord and coord[0] is not None else (None, None)
        res = backend.click(
            element=element if element is not None else None,
            x=x, y=y, button=button or "left", click_count=click_count,
            modifiers=args.get("modifiers"),
        )
        return _maybe_follow_capture(backend, res, capture_after)

    if action == "set_value":
        element = args.get("element")
        if element is None:
            return json.dumps({"error": "set_value requires `element` from a prior capture"})
        if "value" not in args:
            return json.dumps({"error": "set_value requires `value`"})
        res = backend.set_value(element=int(element), value=str(args.get("value", "")))
        return _maybe_follow_capture(backend, res, capture_after)

    if action == "drag":
        res = backend.drag(
            from_xy=tuple(args["from_coordinate"]) if args.get("from_coordinate") else None,
            to_xy=tuple(args["to_coordinate"]) if args.get("to_coordinate") else None,
            button=args.get("button", "left"),
            modifiers=args.get("modifiers"),
        )
        return _maybe_follow_capture(backend, res, capture_after)

    if action == "scroll":
        res = backend.scroll(
            direction=args.get("direction", "down"),
            amount=int(args.get("amount", 3)),
            element=args.get("element"),
            modifiers=args.get("modifiers"),
            by=args.get("by"),
        )
        return _maybe_follow_capture(backend, res, capture_after)

    if action == "type":
        res = backend.type_text(args.get("text", ""))
        return _maybe_follow_capture(backend, res, capture_after)

    if action == "type_chars":
        res = backend.type_text_chars(
            args.get("text", ""),
            element=args.get("element"),
            delay_ms=_optional_int(args.get("delay_ms")),
        )
        return _maybe_follow_capture(backend, res, capture_after)

    if action == "key":
        res = backend.key(args.get("keys", ""))
        return _maybe_follow_capture(backend, res, capture_after)

    if action == "page":
        page_action = args.get("page_action")
        if not page_action:
            return json.dumps({"error": "page requires `page_action`"})
        if page_action == "enable_javascript_apple_events" and not args.get("user_has_confirmed_enabling"):
            return json.dumps({"error": "enable_javascript_apple_events requires explicit user confirmation"})
        res = backend.page(
            page_action=page_action,
            javascript=args.get("javascript"),
            css_selector=args.get("css_selector"),
            attributes=args.get("attributes"),
            bundle_id=args.get("bundle_id"),
            user_has_confirmed_enabling=bool(args.get("user_has_confirmed_enabling", False)),
        )
        return _maybe_follow_capture(backend, res, capture_after)

    if action == "zoom":
        missing = [name for name in ("x1", "y1", "x2", "y2") if name not in args]
        if missing:
            return json.dumps({"error": f"zoom requires {', '.join(missing)}"})
        cap = backend.zoom(x1=int(args["x1"]), y1=int(args["y1"]), x2=int(args["x2"]), y2=int(args["y2"]))
        return _capture_response(cap)

    if action == "set_recording":
        if "enabled" not in args:
            return json.dumps({"error": "set_recording requires `enabled`"})
        res = backend.set_recording(
            enabled=bool(args.get("enabled")),
            output_dir=args.get("output_dir"),
            video_experimental=bool(args.get("video_experimental", False)),
        )
        return _text_response(res)

    if action == "replay_trajectory":
        directory = args.get("directory")
        if not directory:
            return json.dumps({"error": "replay_trajectory requires `directory`"})
        res = backend.replay_trajectory(
            directory=directory,
            delay_ms=_optional_int(args.get("delay_ms")),
            stop_on_error=bool(args.get("stop_on_error", True)),
        )
        return _text_response(res)

    if action == "set_cursor_enabled":
        if "enabled" not in args:
            return json.dumps({"error": "set_cursor_enabled requires `enabled`"})
        res = backend.set_cursor_enabled(bool(args.get("enabled")))
        return _text_response(res)

    if action == "set_cursor_motion":
        motion = args.get("motion")
        if not isinstance(motion, dict):
            return json.dumps({"error": "set_cursor_motion requires `motion` object"})
        res = backend.set_cursor_motion(motion)
        return _text_response(res)

    return json.dumps({"error": f"unknown action {action!r}"})


def _optional_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    return int(value)


# ---------------------------------------------------------------------------
# Response shaping
# ---------------------------------------------------------------------------

def _text_response(res: ActionResult) -> str:
    payload: Dict[str, Any] = {"ok": res.ok, "action": res.action}
    if res.message:
        payload["message"] = res.message
    if res.meta:
        payload["meta"] = res.meta
    return json.dumps(payload)


def _capture_response(cap: CaptureResult) -> str:
    element_index = _format_elements(cap.elements)
    summary_lines = [
        f"capture mode={cap.mode} {cap.width}x{cap.height}"
        + (f" app={cap.app}" if cap.app else "")
        + (f" window={cap.window_title!r}" if cap.window_title else ""),
        f"{len(cap.elements)} interactable element(s):",
    ]
    if element_index:
        summary_lines.extend(element_index)
    summary = "\n".join(summary_lines)

    screenshot_path = cap.image_path
    screenshot_mime_type = cap.image_mime_type or "image/png"
    if cap.image_bytes and cap.mode != "ax" and not screenshot_path:
        screenshot_path = _persist_capture_image(cap)

    payload: Dict[str, Any] = {
        "mode": cap.mode,
        "width": cap.width,
        "height": cap.height,
        "app": cap.app,
        "window_title": cap.window_title,
        "elements": [_element_to_dict(e) for e in cap.elements],
        "summary": summary,
    }
    if screenshot_path:
        payload.update({
            "screenshot_path": screenshot_path,
            "screenshot_mime_type": screenshot_mime_type,
            "screenshot_bytes": cap.image_bytes_len,
            "hint": "If visual details are needed, call vision_analyze with screenshot_path.",
        })
    return json.dumps(payload)


def _persist_capture_image(cap: CaptureResult) -> Optional[str]:
    """Persist transient screenshot bytes to Hermes cache and return its path."""
    if not cap.image_bytes:
        return None
    data = cap.image_bytes
    if not data:
        return None

    from hermes_constants import get_hermes_home
    home = get_hermes_home()

    cache_dir = home / "cache" / "computer_use" / "screenshots" / time.strftime("%Y-%m-%d")
    cache_dir.mkdir(parents=True, exist_ok=True)
    ext = _image_extension(cap.image_mime_type)
    filename = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}{ext}"
    path = cache_dir / filename
    path.write_bytes(data)
    return str(path)


def _image_extension(mime_type: str) -> str:
    normalized = (mime_type or "").lower().split(";", 1)[0].strip()
    if normalized in {"image/jpeg", "image/jpg"}:
        return ".jpg"
    if normalized == "image/webp":
        return ".webp"
    if normalized == "image/gif":
        return ".gif"
    return ".png"


def _maybe_follow_capture(
    backend: ComputerUseBackend, res: ActionResult, do_capture: bool,
) -> str:
    if not do_capture:
        return _text_response(res)
    try:
        cap = backend.capture(mode="som")
    except Exception as e:
        logger.warning("follow-up capture failed: %s", e)
        return _text_response(res)
    data = json.loads(_capture_response(cap))
    data["action"] = res.action
    data["ok"] = res.ok
    if res.message:
        data["message"] = res.message
    return json.dumps(data)


def _format_elements(elements: List[UIElement], max_lines: int = 40) -> List[str]:
    out: List[str] = []
    for e in elements[:max_lines]:
        label = e.label.replace("\n", " ")[:60]
        out.append(f"  #{e.index} {e.role} {label!r} @ {e.bounds}"
                   + (f" [{e.app}]" if e.app else ""))
    if len(elements) > max_lines:
        out.append(f"  ... +{len(elements) - max_lines} more (call capture with app= to narrow)")
    return out


def _element_to_dict(e: UIElement) -> Dict[str, Any]:
    return {
        "index": e.index,
        "role": e.role,
        "label": e.label,
        "bounds": list(e.bounds),
        "app": e.app,
    }


# ---------------------------------------------------------------------------
# Availability check (used by the tool registry check_fn)
# ---------------------------------------------------------------------------

def check_computer_use_requirements() -> bool:
    """Return True iff computer_use can run on this host.

    Conditions: macOS + cua-driver binary installed (or override via env).
    """
    if sys.platform != "darwin":
        return False
    from tools.computer_use.cua_backend import cua_driver_binary_available
    return cua_driver_binary_available()


def get_computer_use_schema() -> Dict[str, Any]:
    from tools.computer_use.schema import COMPUTER_USE_SCHEMA
    return COMPUTER_USE_SCHEMA
