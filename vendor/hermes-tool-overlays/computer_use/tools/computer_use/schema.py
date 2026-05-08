"""Schema for the generic `computer_use` tool.

Model-agnostic. Any tool-calling model can drive this. Vision-capable models
should prefer `capture(mode='som')` then `click(element=N)` — much more
reliable than pixel coordinates. Pixel coordinates remain supported for
models that were trained on them (e.g. Claude's computer-use RL).
"""

from __future__ import annotations

from typing import Any, Dict


# One consolidated tool with an `action` discriminator. This keeps the Hermes
# tool surface compact while covering the current cua-driver MCP surface.
COMPUTER_USE_SCHEMA: Dict[str, Any] = {
    "name": "computer_use",
    "description": (
        "Control the user's Mac through cua-driver MCP: inspect apps/windows, "
        "capture UI state, click, type, press keys, set AX values, scroll, "
        "use browser page primitives, zoom screenshots, and record/replay "
        "trajectories. Preferred workflow: list_windows or focus_app, then "
        "capture(mode='som'), then act by element index. Pixel coordinates "
        "are window-local screenshot pixels from the most recent "
        "get_window_state/capture image, not global screen coordinates. "
        "macOS only; requires cua-driver to be installed."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "check_permissions",
                    "capture",
                    "screenshot",
                    "click",
                    "double_click",
                    "right_click",
                    "drag",
                    "scroll",
                    "set_value",
                    "type",
                    "type_chars",
                    "key",
                    "wait",
                    "list_apps",
                    "list_windows",
                    "screen_size",
                    "cursor_position",
                    "cursor_state",
                    "focus_app",
                    "page",
                    "zoom",
                    "set_recording",
                    "replay_trajectory",
                    "set_cursor_enabled",
                    "set_cursor_motion",
                ],
                "description": (
                    "Which action to perform. Read-only actions include "
                    "check_permissions with prompt=false, capture, screenshot, "
                    "list_apps, list_windows, screen_size, cursor_position, "
                    "cursor_state, and wait. Mutating actions require approval "
                    "unless auto-approved."
                ),
            },
            # ── capture ────────────────────────────────────────────
            "mode": {
                "type": "string",
                "enum": ["som", "vision", "ax"],
                "description": (
                    "Capture mode. `som` (default) captures a screenshot "
                    "artifact with numbered overlays plus the AX tree — best "
                    "for element-index workflows. The tool response returns "
                    "AX/SOM text and a local screenshot_path, never inline "
                    "base64. `vision` is a plain screenshot artifact. "
                    "`ax` is the accessibility tree only (no image; useful "
                    "for text-only models)."
                ),
            },
            "app": {
                "type": "string",
                "description": (
                    "Optional. Limit capture/action to a specific app "
                    "(by name, e.g. 'Safari', or bundle ID, "
                    "'com.apple.Safari'). If omitted, operates on the "
                    "frontmost app's window or the whole screen."
                ),
            },
            # ── click / scroll targeting ───────────────────────────
            "element": {
                "type": "integer",
                "description": (
                    "The 1-based SOM index returned by the last "
                    "`capture(mode='som')` call. Strongly preferred over "
                    "raw coordinates."
                ),
            },
            "coordinate": {
                "type": "array",
                "items": {"type": "integer"},
                "minItems": 2,
                "maxItems": 2,
                "description": (
                    "Pixel coordinates [x, y] in window-local screenshot "
                    "space, matching the PNG returned by capture/get_window_state. "
                    "Used for pointer actions when no element index is available."
                ),
            },
            "button": {
                "type": "string",
                "enum": ["left", "right"],
                "description": "Mouse button. Defaults to left.",
            },
            "modifiers": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["cmd", "shift", "option", "alt", "ctrl", "fn"],
                },
                "description": (
                    "Modifier keys held during coordinate-targeted clicks "
                    "and drags. Element-indexed actions may ignore modifiers."
                ),
            },
            # ── drag ───────────────────────────────────────────────
            "from_coordinate": {
                "type": "array",
                "items": {"type": "integer"},
                "minItems": 2, "maxItems": 2,
                "description": "Source [x,y] for drag in window-local screenshot pixels.",
            },
            "to_coordinate": {
                "type": "array",
                "items": {"type": "integer"},
                "minItems": 2, "maxItems": 2,
                "description": "Target [x,y] for drag in window-local screenshot pixels.",
            },
            # ── scroll ─────────────────────────────────────────────
            "direction": {
                "type": "string",
                "enum": ["up", "down", "left", "right"],
                "description": "Scroll direction.",
            },
            "amount": {
                "type": "integer",
                "description": "Scroll wheel ticks. Default 3.",
            },
            "by": {
                "type": "string",
                "enum": ["line", "page"],
                "description": "Scroll granularity for cua-driver scroll. Default line.",
            },
            "value": {
                "type": "string",
                "description": "Value for action='set_value' on a captured AX element.",
            },
            # ── type / key / wait ──────────────────────────────────
            "text": {
                "type": "string",
                "description": "Text to type (respects the current layout).",
            },
            "keys": {
                "type": "string",
                "description": (
                    "Key combo, e.g. 'cmd+s', 'ctrl+alt+t', 'return', "
                    "'escape', 'tab'. Use '+' to combine."
                ),
            },
            "seconds": {
                "type": "number",
                "description": "Seconds to wait. Max 30.",
            },
            "prompt": {
                "type": "boolean",
                "description": (
                    "Only for check_permissions. Defaults false for passive "
                    "readiness; true may raise macOS permission dialogs and "
                    "therefore requires approval."
                ),
            },
            "pid": {
                "type": "integer",
                "description": "Optional explicit target pid. Defaults to the last capture/focus target.",
            },
            "window_id": {
                "type": "integer",
                "description": "Optional explicit CGWindowID. Required by CUA for element-indexed actions.",
            },
            "on_screen_only": {
                "type": "boolean",
                "description": "Only for list_windows. If true, omit minimized/off-Space windows.",
            },
            "format": {
                "type": "string",
                "enum": ["png", "jpeg"],
                "description": "Image format for screenshot. Default png.",
            },
            "quality": {
                "type": "integer",
                "minimum": 1,
                "maximum": 95,
                "description": "JPEG quality for screenshot.",
            },
            # ── focus_app ──────────────────────────────────────────
            "raise_window": {
                "type": "boolean",
                "description": (
                    "Only for action='focus_app'. If true, brings the "
                    "window to front (DISRUPTS the user). Default false "
                    "— input is routed to the app without raising, "
                    "matching the background co-work model."
                ),
            },
            # ── return shape ───────────────────────────────────────
            "capture_after": {
                "type": "boolean",
                "description": (
                    "If true, take a follow-up capture after the action "
                    "and include it in the response. Saves a round-trip "
                    "when you need to verify an action's effect."
                ),
            },
            "page_action": {
                "type": "string",
                "enum": [
                    "execute_javascript",
                    "get_text",
                    "query_dom",
                    "enable_javascript_apple_events",
                ],
                "description": "Browser page primitive for action='page'.",
            },
            "javascript": {
                "type": "string",
                "description": "JavaScript for page_action='execute_javascript'.",
            },
            "css_selector": {
                "type": "string",
                "description": "CSS selector for page_action='query_dom'.",
            },
            "attributes": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Attributes to include for page_action='query_dom'.",
            },
            "bundle_id": {
                "type": "string",
                "description": "Browser bundle id for page_action='enable_javascript_apple_events'.",
            },
            "user_has_confirmed_enabling": {
                "type": "boolean",
                "description": "Required true after explicit user permission for enabling JavaScript Apple Events.",
            },
            "x1": {"type": "integer", "description": "Zoom rectangle left x in capture pixels."},
            "y1": {"type": "integer", "description": "Zoom rectangle top y in capture pixels."},
            "x2": {"type": "integer", "description": "Zoom rectangle right x in capture pixels."},
            "y2": {"type": "integer", "description": "Zoom rectangle bottom y in capture pixels."},
            "enabled": {
                "type": "boolean",
                "description": "Boolean for set_recording or set_cursor_enabled.",
            },
            "output_dir": {
                "type": "string",
                "description": "Trajectory output directory for set_recording enabled=true.",
            },
            "video_experimental": {
                "type": "boolean",
                "description": "Optional CUA recording video flag.",
            },
            "directory": {
                "type": "string",
                "description": "Trajectory directory for replay_trajectory.",
            },
            "delay_ms": {
                "type": "integer",
                "description": "Delay for type_chars or replay_trajectory.",
            },
            "stop_on_error": {
                "type": "boolean",
                "description": "For replay_trajectory. Default true.",
            },
            "motion": {
                "type": "object",
                "description": "CUA agent cursor motion settings for set_cursor_motion.",
                "additionalProperties": True,
            },
        },
        "required": ["action"],
    },
}


def get_computer_use_schema() -> Dict[str, Any]:
    """Return the generic OpenAI function-calling schema."""
    return COMPUTER_USE_SCHEMA
