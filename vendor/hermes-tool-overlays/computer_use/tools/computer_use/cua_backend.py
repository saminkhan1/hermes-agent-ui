"""Cua-driver backend (macOS only).

Speaks MCP over stdio to `cua-driver`. The Python `mcp` SDK is async, so we
run a dedicated asyncio event loop on a background thread and marshal sync
calls through it.

Install: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"`

After install, `cua-driver` is on $PATH and supports `cua-driver mcp` (stdio
transport) which is what we invoke.

The private SkyLight SPIs cua-driver uses (SLEventPostToPid, SLPSPostEvent-
RecordTo, _AXObserverAddNotificationAndCheckRemote) are not Apple-public and
can break on OS updates. Pin the installed version via `HERMES_CUA_DRIVER_
VERSION` if you want reproducibility across an OS bump.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
from concurrent.futures import Future
from typing import Any, Dict, List, Optional, Tuple

from tools.computer_use.backend import (
    ActionResult,
    CaptureResult,
    ComputerUseBackend,
    UIElement,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Version pinning
# ---------------------------------------------------------------------------

# The SkyLight SPIs cua-driver calls are private. We pin a known-good version
# so OS updates don't silently change the surface area our agent depends on.
# Users on newer macOS releases may need to bump this and re-run
# `hermes tools` to take the updated binary.
PINNED_CUA_DRIVER_VERSION = os.environ.get("HERMES_CUA_DRIVER_VERSION", "0.5.0")

# Env var override for the cua-driver binary path (mostly for tests / CI).
_CUA_DRIVER_CMD = os.environ.get("HERMES_CUA_DRIVER_CMD", "cua-driver")
_CUA_DRIVER_ARGS = ["mcp"]  # stdio MCP transport


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_macos() -> bool:
    return sys.platform == "darwin"


def _is_arm_mac() -> bool:
    return _is_macos() and platform.machine() == "arm64"


def cua_driver_binary_available() -> bool:
    """True if `cua-driver` is on $PATH or HERMES_CUA_DRIVER_CMD resolves."""
    return bool(shutil.which(_CUA_DRIVER_CMD))


def cua_driver_install_hint() -> str:
    return (
        "cua-driver is not installed. Install with:\n"
        '  /bin/bash -c "$(curl -fsSL '
        'https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"\n'
        "Or run `hermes tools` and enable the Computer Use toolset to install it automatically."
    )


# ---------------------------------------------------------------------------
# Asyncio bridge — one long-lived loop on a background thread
# ---------------------------------------------------------------------------

class _AsyncBridge:
    """Runs one asyncio loop on a daemon thread; marshals coroutines from the caller."""

    def __init__(self) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._ready = threading.Event()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._ready.clear()

        def _run() -> None:
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            self._ready.set()
            try:
                self._loop.run_forever()
            finally:
                try:
                    self._loop.close()
                except Exception:
                    pass

        self._thread = threading.Thread(target=_run, daemon=True, name="cua-driver-loop")
        self._thread.start()
        if not self._ready.wait(timeout=5.0):
            raise RuntimeError("cua-driver asyncio bridge failed to start")

    def run(self, coro, timeout: Optional[float] = 30.0) -> Any:
        if not self._loop or not self._thread or not self._thread.is_alive():
            raise RuntimeError("cua-driver bridge not started")
        fut: Future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return fut.result(timeout=timeout)

    def stop(self) -> None:
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread:
            self._thread.join(timeout=2.0)
        self._thread = None
        self._loop = None


# ---------------------------------------------------------------------------
# MCP session (lazy, shared across tool calls)
# ---------------------------------------------------------------------------

class _CuaDriverSession:
    """Holds the mcp ClientSession. Spawned lazily; re-entered on drop."""

    def __init__(self, bridge: _AsyncBridge) -> None:
        self._bridge = bridge
        self._session = None            # mcp.ClientSession
        self._exit_stack = None         # AsyncExitStack for stdio_client + ClientSession
        self._lock = threading.Lock()
        self._started = False

    def _require_started(self) -> None:
        if not self._started:
            raise RuntimeError("cua-driver session not started")

    async def _aenter(self) -> None:
        from contextlib import AsyncExitStack
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        if not cua_driver_binary_available():
            raise RuntimeError(cua_driver_install_hint())

        params = StdioServerParameters(
            command=_CUA_DRIVER_CMD,
            args=_CUA_DRIVER_ARGS,
            env={**os.environ},        # cua-driver needs HOME / TMPDIR
        )
        stack = AsyncExitStack()
        read, write = await stack.enter_async_context(stdio_client(params))
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        self._exit_stack = stack
        self._session = session

    async def _aexit(self) -> None:
        if self._exit_stack is not None:
            try:
                await self._exit_stack.aclose()
            except Exception as e:  # pragma: no cover
                logger.warning("cua-driver shutdown error: %s", e)
        self._exit_stack = None
        self._session = None

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._bridge.start()
            self._bridge.run(self._aenter(), timeout=15.0)
            self._started = True

    def stop(self) -> None:
        with self._lock:
            if not self._started:
                return
            try:
                self._bridge.run(self._aexit(), timeout=5.0)
            finally:
                self._started = False

    # ── Tool invocation ──────────────────────────────────────────────
    async def _call_tool_async(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        result = await self._session.call_tool(name, args)
        # Normalize: mcp returns content parts. We want a dict.
        return _extract_tool_result(result)

    def call_tool(self, name: str, args: Dict[str, Any], timeout: float = 30.0) -> Dict[str, Any]:
        self._require_started()
        return self._bridge.run(self._call_tool_async(name, args), timeout=timeout)


def _extract_tool_result(mcp_result: Any) -> Dict[str, Any]:
    """Convert an mcp CallToolResult into a plain dict.

    cua-driver returns structured metadata plus MCP image/text parts. We flatten:
      {"data": <structured metadata or parsed text>, "images": [{"data": b64, "mime_type": ...}], "isError": bool}
    """
    structured = getattr(mcp_result, "structuredContent", None)
    data: Any = structured if structured is not None else None
    images: List[Dict[str, str]] = []
    is_error = bool(getattr(mcp_result, "isError", False))
    text_chunks: List[str] = []
    for part in getattr(mcp_result, "content", []) or []:
        ptype = getattr(part, "type", None)
        if ptype == "text":
            text_chunks.append(getattr(part, "text", "") or "")
        elif ptype == "image":
            b64 = getattr(part, "data", None)
            if b64:
                mime_type = (
                    getattr(part, "mimeType", None)
                    or getattr(part, "mime_type", None)
                    or "image/png"
                )
                images.append({"data": b64, "mime_type": str(mime_type)})
    if data is None and text_chunks:
        joined = "\n".join(t for t in text_chunks if t)
        try:
            data = json.loads(joined) if joined.strip().startswith(("{", "[")) else joined
        except json.JSONDecodeError:
            data = joined
    return {"data": data, "images": images, "isError": is_error}


def _first_image(out: Dict[str, Any]) -> Tuple[Optional[bytes], str, int]:
    image_bytes: Optional[bytes] = None
    image_bytes_len = 0
    image_mime_type = "image/png"
    images = out.get("images") or []
    if images:
        image = images[0]
        encoded_image = image.get("data")
        image_mime_type = image.get("mime_type") or image_mime_type
        if encoded_image:
            try:
                image_bytes = base64.b64decode(encoded_image, validate=False)
            except Exception:
                image_bytes = None
            if image_bytes:
                image_bytes_len = len(image_bytes)
    return image_bytes, image_mime_type, image_bytes_len


# ---------------------------------------------------------------------------
# The backend itself
# ---------------------------------------------------------------------------

class CuaDriverBackend(ComputerUseBackend):
    """Default computer-use backend. macOS-only via cua-driver MCP."""

    def __init__(self) -> None:
        self._bridge = _AsyncBridge()
        self._session = _CuaDriverSession(self._bridge)
        self._last_pid: Optional[int] = None
        self._last_window_id: Optional[int] = None

    # ── Lifecycle ──────────────────────────────────────────────────
    def start(self) -> None:
        self._session.start()

    def stop(self) -> None:
        try:
            self._session.stop()
        finally:
            self._bridge.stop()

    def is_available(self) -> bool:
        if not _is_macos():
            return False
        return cua_driver_binary_available()

    # ── Capture ────────────────────────────────────────────────────
    def capture(self, mode: str = "som", app: Optional[str] = None) -> CaptureResult:
        window = self._resolve_window(app)
        if not window:
            return CaptureResult(mode=mode, width=0, height=0, app=app or "",
                                 window_title="", elements=[])

        pid = int(window.get("pid") or 0)
        window_id = int(window.get("window_id") or window.get("windowId") or 0)
        driver_mode = "vision" if mode == "vision" else ("ax" if mode == "ax" else "som")
        # cua-driver v0.0.13 controls get_window_state's response mode through
        # persistent config rather than a per-call argument.
        self._session.call_tool("set_config", {"key": "capture_mode", "value": driver_mode})
        out = self._session.call_tool("get_window_state", {"pid": pid, "window_id": window_id})
        data = out["data"] if isinstance(out["data"], dict) else {}

        width = int(data.get("screenshot_width") or data.get("width") or _bounds_size(window)[0])
        height = int(data.get("screenshot_height") or data.get("height") or _bounds_size(window)[1])
        elements = _parse_tree_markdown(
            str(data.get("tree_markdown") or ""),
            app=str(data.get("name") or window.get("app_name") or app or ""),
            pid=pid,
            window_id=window_id,
        )

        image_bytes, image_mime_type, image_bytes_len = _first_image(out)

        self._last_pid = pid
        self._last_window_id = window_id
        return CaptureResult(
            mode=mode,
            width=width,
            height=height,
            image_bytes=image_bytes,
            image_mime_type=image_mime_type,
            elements=elements,
            app=str(data.get("name") or window.get("app_name") or app or ""),
            window_title=str(window.get("title") or data.get("window_title") or ""),
            image_bytes_len=image_bytes_len,
        )

    def screenshot(
        self,
        *,
        window_id: Optional[int] = None,
        image_format: str = "png",
        quality: Optional[int] = None,
    ) -> CaptureResult:
        args: Dict[str, Any] = {"format": image_format}
        if quality is not None:
            args["quality"] = int(quality)
        target_window_id = window_id or self._target_window_id(required=False)
        if target_window_id:
            args["window_id"] = int(target_window_id)
        out = self._session.call_tool("screenshot", args)
        image_bytes, image_mime_type, image_bytes_len = _first_image(out)
        data = out["data"] if isinstance(out["data"], dict) else {}
        return CaptureResult(
            mode="screenshot",
            width=int(data.get("width") or data.get("screenshot_width") or 0),
            height=int(data.get("height") or data.get("screenshot_height") or 0),
            image_bytes=image_bytes,
            image_mime_type=image_mime_type,
            image_bytes_len=image_bytes_len,
            window_title=str(data.get("window_title") or ""),
        )

    # ── Pointer ────────────────────────────────────────────────────
    def click(
        self,
        *,
        element: Optional[int] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        button: str = "left",
        click_count: int = 1,
        modifiers: Optional[List[str]] = None,
    ) -> ActionResult:
        if button not in {"left", "right"}:
            return ActionResult(ok=False, action="click", message=f"unsupported click button: {button}")

        tool_name = "click"
        if button == "right":
            tool_name = "right_click"
        elif click_count == 2:
            tool_name = "double_click"

        args: Dict[str, Any] = {"pid": self._target_pid()}
        if element is not None:
            if modifiers:
                return ActionResult(ok=False, action=tool_name,
                                    message="modifiers require coordinate targeting")
            args["element_index"] = int(element)
            args["window_id"] = self._target_window_id()
        elif x is not None and y is not None:
            args["x"] = int(x)
            args["y"] = int(y)
            if self._target_window_id(required=False):
                args["window_id"] = self._target_window_id()
            if tool_name == "click" and click_count not in (1, 2):
                args["count"] = int(click_count)
            if modifiers:
                args["modifier"] = modifiers
        else:
            return ActionResult(ok=False, action=tool_name,
                                message="click requires element= or x/y")
        return self._action(tool_name, args)

    def drag(
        self,
        *,
        from_xy: Optional[Tuple[int, int]] = None,
        to_xy: Optional[Tuple[int, int]] = None,
        button: str = "left",
        modifiers: Optional[List[str]] = None,
    ) -> ActionResult:
        args: Dict[str, Any] = {"pid": self._target_pid(), "button": button}
        if from_xy is not None:
            args["from_x"], args["from_y"] = int(from_xy[0]), int(from_xy[1])
        else:
            return ActionResult(ok=False, action="drag", message="drag requires pixel coordinates")
        if to_xy is not None:
            args["to_x"], args["to_y"] = int(to_xy[0]), int(to_xy[1])
        else:
            return ActionResult(ok=False, action="drag", message="drag requires pixel coordinates")
        if self._target_window_id(required=False):
            args["window_id"] = self._target_window_id()
        if modifiers:
            args["modifier"] = modifiers
        return self._action("drag", args)

    def scroll(
        self,
        *,
        direction: str,
        amount: int = 3,
        element: Optional[int] = None,
        modifiers: Optional[List[str]] = None,
        by: Optional[str] = None,
    ) -> ActionResult:
        args: Dict[str, Any] = {"pid": self._target_pid(), "direction": direction, "amount": int(amount)}
        if element is not None:
            args["element_index"] = int(element)
            args["window_id"] = self._target_window_id()
        if by:
            args["by"] = by
        return self._action("scroll", args)

    # ── Keyboard ───────────────────────────────────────────────────
    def type_text(self, text: str) -> ActionResult:
        return self._action("type_text", {"pid": self._target_pid(), "text": text})

    def type_text_chars(
        self,
        text: str,
        *,
        element: Optional[int] = None,
        delay_ms: Optional[int] = None,
    ) -> ActionResult:
        args: Dict[str, Any] = {"pid": self._target_pid(), "text": text}
        if element is not None:
            args["element_index"] = int(element)
            args["window_id"] = self._target_window_id()
        if delay_ms is not None:
            args["delay_ms"] = int(delay_ms)
        return self._action("type_text_chars", args)

    def key(self, keys: str) -> ActionResult:
        parts = [p for p in re.split(r"[+\s]+", keys.lower()) if p]
        if len(parts) > 1:
            return self._action("hotkey", {"pid": self._target_pid(), "keys": parts})
        return self._action("press_key", {"pid": self._target_pid(), "key": parts[0] if parts else keys})

    def set_value(self, *, element: int, value: str) -> ActionResult:
        return self._action("set_value", {
            "pid": self._target_pid(),
            "window_id": self._target_window_id(),
            "element_index": int(element),
            "value": value,
        })

    # ── Introspection ──────────────────────────────────────────────
    def check_permissions(self, prompt: bool = False) -> Dict[str, Any]:
        out = self._session.call_tool("check_permissions", {"prompt": bool(prompt)})
        data = out["data"] if isinstance(out["data"], dict) else {}
        return data

    def list_apps(self) -> List[Dict[str, Any]]:
        out = self._session.call_tool("list_apps", {})
        data = out["data"] if isinstance(out["data"], (list, dict)) else []
        if isinstance(data, dict):
            data = data.get("apps", [])
        return list(data or [])

    def list_windows(
        self,
        *,
        app: Optional[str] = None,
        pid: Optional[int] = None,
        on_screen_only: bool = False,
    ) -> List[Dict[str, Any]]:
        args: Dict[str, Any] = {"on_screen_only": bool(on_screen_only)}
        if pid is not None:
            args["pid"] = int(pid)
        out = self._session.call_tool("list_windows", args)
        data = out["data"] if isinstance(out["data"], (list, dict)) else []
        windows = data.get("windows", []) if isinstance(data, dict) else data
        windows = [w for w in windows if isinstance(w, dict)]
        if app:
            needle = app.lower()
            windows = [
                w for w in windows
                if needle in str(w.get("app_name", "")).lower()
                or needle in str(w.get("bundle_id", "")).lower()
                or needle in str(w.get("title", "")).lower()
            ]
        return windows

    def get_screen_size(self) -> Dict[str, Any]:
        out = self._session.call_tool("get_screen_size", {})
        return out["data"] if isinstance(out["data"], dict) else {}

    def get_cursor_position(self) -> Dict[str, Any]:
        out = self._session.call_tool("get_cursor_position", {})
        return out["data"] if isinstance(out["data"], dict) else {}

    def get_cursor_state(self) -> Dict[str, Any]:
        out = self._session.call_tool("get_agent_cursor_state", {})
        return out["data"] if isinstance(out["data"], dict) else {}

    def focus_app(self, app: str, raise_window: bool = False) -> ActionResult:
        out = self._session.call_tool("launch_app", {"bundle_id": app} if "." in app else {"name": app})
        ok = not out["isError"]
        data = out["data"] if isinstance(out["data"], dict) else {}
        if data.get("pid"):
            self._last_pid = int(data["pid"])
        windows = data.get("windows") if isinstance(data, dict) else None
        if windows:
            self._last_window_id = int(windows[0].get("window_id") or windows[0].get("windowId") or 0)
        return ActionResult(ok=ok, action="focus_app", message=str(data.get("message", "")), meta=data)

    def page(
        self,
        *,
        page_action: str,
        javascript: Optional[str] = None,
        css_selector: Optional[str] = None,
        attributes: Optional[List[str]] = None,
        bundle_id: Optional[str] = None,
        user_has_confirmed_enabling: bool = False,
    ) -> ActionResult:
        args: Dict[str, Any] = {"action": page_action}
        if page_action == "enable_javascript_apple_events":
            if bundle_id:
                args["bundle_id"] = bundle_id
            args["user_has_confirmed_enabling"] = bool(user_has_confirmed_enabling)
        else:
            args["pid"] = self._target_pid()
            args["window_id"] = self._target_window_id()
        if javascript is not None:
            args["javascript"] = javascript
        if css_selector is not None:
            args["css_selector"] = css_selector
        if attributes is not None:
            args["attributes"] = attributes
        return self._action("page", args)

    def zoom(self, *, x1: int, y1: int, x2: int, y2: int) -> CaptureResult:
        out = self._session.call_tool("zoom", {
            "pid": self._target_pid(),
            "window_id": self._target_window_id(),
            "x1": int(x1),
            "y1": int(y1),
            "x2": int(x2),
            "y2": int(y2),
        })
        image_bytes, image_mime_type, image_bytes_len = _first_image(out)
        data = out["data"] if isinstance(out["data"], dict) else {}
        return CaptureResult(
            mode="zoom",
            width=int(data.get("width") or data.get("screenshot_width") or 0),
            height=int(data.get("height") or data.get("screenshot_height") or 0),
            image_bytes=image_bytes,
            image_mime_type=image_mime_type,
            image_bytes_len=image_bytes_len,
        )

    def set_recording(
        self,
        *,
        enabled: bool,
        output_dir: Optional[str] = None,
        video_experimental: bool = False,
    ) -> ActionResult:
        args: Dict[str, Any] = {"enabled": bool(enabled)}
        if output_dir:
            args["output_dir"] = output_dir
        if video_experimental:
            args["video_experimental"] = True
        return self._action("set_recording", args)

    def replay_trajectory(
        self,
        *,
        directory: str,
        delay_ms: Optional[int] = None,
        stop_on_error: bool = True,
    ) -> ActionResult:
        args: Dict[str, Any] = {"dir": directory, "stop_on_error": bool(stop_on_error)}
        if delay_ms is not None:
            args["delay_ms"] = int(delay_ms)
        return self._action("replay_trajectory", args)

    def set_cursor_enabled(self, enabled: bool) -> ActionResult:
        return self._action("set_agent_cursor_enabled", {"enabled": bool(enabled)})

    def set_cursor_motion(self, settings: Dict[str, Any]) -> ActionResult:
        return self._action("set_agent_cursor_motion", dict(settings))

    # ── Internal ───────────────────────────────────────────────────
    def _target_pid(self) -> int:
        pid = getattr(self, "_last_pid", None)
        if not pid:
            window = self._resolve_window(None)
            if window:
                pid = int(window.get("pid") or 0)
                self._last_pid = pid
                self._last_window_id = int(window.get("window_id") or window.get("windowId") or 0)
        if not pid:
            raise RuntimeError("computer_use action requires a prior capture/focus target")
        return int(pid)

    def _target_window_id(self, required: bool = True) -> int:
        window_id = getattr(self, "_last_window_id", None)
        if not window_id and required:
            raise RuntimeError("element-indexed action requires a prior capture")
        return int(window_id or 0)

    def _resolve_window(self, app: Optional[str]) -> Optional[Dict[str, Any]]:
        out = self._session.call_tool("list_windows", {})
        data = out["data"] if isinstance(out["data"], (list, dict)) else []
        windows = data.get("windows", []) if isinstance(data, dict) else data
        windows = [w for w in windows if isinstance(w, dict) and int(w.get("pid") or 0)]
        if app:
            needle = app.lower()
            app_matches = [w for w in windows if needle in str(w.get("app_name", "")).lower()
                           or needle in str(w.get("bundle_id", "")).lower()]
            title_matches = [w for w in windows if needle in str(w.get("title", "")).lower()]
            windows = app_matches or title_matches
        if not windows:
            return None
        windows.sort(key=lambda w: (
            not bool(w.get("title")),
            _bounds_size(w)[1] < 80,
            not bool(w.get("on_current_space")),
            not bool(w.get("is_on_screen")),
            int(w.get("layer") or 0),
            int(w.get("z_index") or 10**9),
        ))
        return windows[0]

    def _action(self, name: str, args: Dict[str, Any]) -> ActionResult:
        try:
            out = self._session.call_tool(name, args)
        except Exception as e:
            logger.exception("cua-driver %s call failed", name)
            return ActionResult(ok=False, action=name, message=f"cua-driver error: {e}")
        ok = not out["isError"]
        message = ""
        data = out["data"]
        if isinstance(data, dict):
            message = str(data.get("message", ""))
        elif isinstance(data, str):
            message = data
        return ActionResult(ok=ok, action=name, message=message,
                            meta=data if isinstance(data, dict) else {})


def _bounds_size(d: Dict[str, Any]) -> Tuple[int, int]:
    bounds = d.get("bounds") or {}
    if isinstance(bounds, dict):
        return int(bounds.get("width", bounds.get("w", 0)) or 0), int(bounds.get("height", bounds.get("h", 0)) or 0)
    if isinstance(bounds, (list, tuple)) and len(bounds) == 4:
        return int(bounds[2]), int(bounds[3])
    return 0, 0


def _parse_tree_markdown(markdown: str, *, app: str = "", pid: int = 0, window_id: int = 0) -> List[UIElement]:
    elements: List[UIElement] = []
    pattern = re.compile(r"\[(\d+)\]\s+(AX\w+)(?:\s+\"([^\"]*)\")?")
    for match in pattern.finditer(markdown):
        index = int(match.group(1))
        if index <= 0:
            continue
        elements.append(UIElement(
            index=index,
            role=match.group(2),
            label=match.group(3) or "",
            bounds=(0, 0, 0, 0),
            app=app,
            pid=pid,
            window_id=window_id,
        ))
    return elements
