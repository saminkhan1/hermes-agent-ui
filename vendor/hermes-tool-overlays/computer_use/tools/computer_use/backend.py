"""Abstract backend interface for computer use.

Any implementation must return the shape described below. All methods are
synchronous; async is handled inside the backend implementation if needed.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple


@dataclass
class UIElement:
    """One interactable element on the current screen."""

    index: int                       # 1-based SOM index
    role: str                        # AX role (AXButton, AXTextField, ...)
    label: str = ""                  # AXTitle / AXDescription / AXValue snippet
    bounds: Tuple[int, int, int, int] = (0, 0, 0, 0)  # x, y, w, h (logical px)
    app: str = ""                    # owning bundle ID or app name
    pid: int = 0                     # owning process PID
    window_id: int = 0               # SkyLight / CG window ID
    attributes: Dict[str, Any] = field(default_factory=dict)

    def center(self) -> Tuple[int, int]:
        x, y, w, h = self.bounds
        return x + w // 2, y + h // 2


@dataclass
class CaptureResult:
    """Result of a screen capture call.

    At least one of image data / elements is populated depending on capture mode:
      * mode="vision" → image data only
      * mode="ax"     → elements only
      * mode="som"    → both (default): screenshot already has numbered overlays
                         drawn by the backend, and `elements` holds the
                         matching index → element mapping.

    image_bytes holds transient capture bytes used only to write a local artifact;
    callers must not return it inline to the model or durable transcript.
    """

    mode: str
    width: int                      # screenshot width in logical pixels
    height: int
    image_bytes: Optional[bytes] = None
    image_mime_type: str = "image/png"
    image_path: Optional[str] = None
    elements: List[UIElement] = field(default_factory=list)
    # Optional: the target app/window the elements were captured for.
    app: str = ""
    window_title: str = ""
    # Raw image bytes written to the local artifact.
    image_bytes_len: int = 0


@dataclass
class ActionResult:
    """Result of any action (click / type / scroll / drag / key / wait)."""

    ok: bool
    action: str
    message: str = ""                # human-readable summary
    # Optional trailing screenshot — set when the caller asked for a
    # post-action capture or the backend always returns one.
    capture: Optional[CaptureResult] = None
    # Arbitrary extra fields for debugging / telemetry.
    meta: Dict[str, Any] = field(default_factory=dict)


class ComputerUseBackend(ABC):
    """Lifecycle: `start()` before first use, `stop()` at shutdown."""

    @abstractmethod
    def start(self) -> None: ...

    @abstractmethod
    def stop(self) -> None: ...

    @abstractmethod
    def is_available(self) -> bool:
        """Return True if the backend can be used on this host right now.

        Used by check_fn gating and by the post-setup wizard.
        """

    # ── Capture ─────────────────────────────────────────────────────
    @abstractmethod
    def capture(self, mode: str = "som", app: Optional[str] = None) -> CaptureResult: ...

    @abstractmethod
    def screenshot(
        self,
        *,
        window_id: Optional[int] = None,
        image_format: str = "png",
        quality: Optional[int] = None,
    ) -> CaptureResult: ...

    # ── Pointer actions ─────────────────────────────────────────────
    @abstractmethod
    def click(
        self,
        *,
        element: Optional[int] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        button: str = "left",           # left | right | middle
        click_count: int = 1,
        modifiers: Optional[List[str]] = None,
    ) -> ActionResult: ...

    @abstractmethod
    def drag(
        self,
        *,
        from_xy: Optional[Tuple[int, int]] = None,
        to_xy: Optional[Tuple[int, int]] = None,
        button: str = "left",
        modifiers: Optional[List[str]] = None,
    ) -> ActionResult: ...

    @abstractmethod
    def scroll(
        self,
        *,
        direction: str,
        amount: int = 3,
        element: Optional[int] = None,
        modifiers: Optional[List[str]] = None,
        by: Optional[str] = None,
    ) -> ActionResult: ...

    # ── Keyboard ────────────────────────────────────────────────────
    @abstractmethod
    def type_text(self, text: str) -> ActionResult: ...

    @abstractmethod
    def type_text_chars(
        self,
        text: str,
        *,
        element: Optional[int] = None,
        delay_ms: Optional[int] = None,
    ) -> ActionResult: ...

    @abstractmethod
    def key(self, keys: str) -> ActionResult:
        """Send a key combo, e.g. 'cmd+s', 'ctrl+alt+t', 'return'."""

    @abstractmethod
    def set_value(self, *, element: int, value: str) -> ActionResult: ...

    # ── Introspection ───────────────────────────────────────────────
    @abstractmethod
    def check_permissions(self, prompt: bool = False) -> Dict[str, Any]:
        """Return Accessibility/Screen Recording readiness from cua-driver."""

    @abstractmethod
    def list_apps(self) -> List[Dict[str, Any]]:
        """Return running apps with bundle IDs, PIDs, window counts."""

    @abstractmethod
    def list_windows(
        self,
        *,
        app: Optional[str] = None,
        pid: Optional[int] = None,
        on_screen_only: bool = False,
    ) -> List[Dict[str, Any]]:
        """Return windows known to WindowServer."""

    @abstractmethod
    def get_screen_size(self) -> Dict[str, Any]: ...

    @abstractmethod
    def get_cursor_position(self) -> Dict[str, Any]: ...

    @abstractmethod
    def get_cursor_state(self) -> Dict[str, Any]: ...

    @abstractmethod
    def focus_app(self, app: str, raise_window: bool = False) -> ActionResult:
        """Route input to `app` (by name or bundle ID). Default: focus without raise."""

    @abstractmethod
    def page(
        self,
        *,
        page_action: str,
        javascript: Optional[str] = None,
        css_selector: Optional[str] = None,
        attributes: Optional[List[str]] = None,
        bundle_id: Optional[str] = None,
        user_has_confirmed_enabling: bool = False,
    ) -> ActionResult: ...

    @abstractmethod
    def zoom(self, *, x1: int, y1: int, x2: int, y2: int) -> CaptureResult: ...

    @abstractmethod
    def set_recording(
        self,
        *,
        enabled: bool,
        output_dir: Optional[str] = None,
        video_experimental: bool = False,
    ) -> ActionResult: ...

    @abstractmethod
    def replay_trajectory(
        self,
        *,
        directory: str,
        delay_ms: Optional[int] = None,
        stop_on_error: bool = True,
    ) -> ActionResult: ...

    @abstractmethod
    def set_cursor_enabled(self, enabled: bool) -> ActionResult: ...

    @abstractmethod
    def set_cursor_motion(self, settings: Dict[str, Any]) -> ActionResult: ...

    # ── Timing ──────────────────────────────────────────────────────
    def wait(self, seconds: float) -> ActionResult:
        """Default implementation: time.sleep."""
        import time
        time.sleep(max(0.0, min(seconds, 30.0)))
        return ActionResult(ok=True, action="wait", message=f"waited {seconds:.2f}s")
