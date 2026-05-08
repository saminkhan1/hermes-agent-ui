"""Computer use toolset — macOS desktop control via cua-driver.

Architecture
------------
This toolset drives macOS apps through cua-driver's background computer-use
primitive. Captures return AX/SOM text plus local screenshot artifacts; image
bytes are not exposed as inline tool-result content.

Wiring
------
* `tool.py`       — registers the `computer_use` tool via tools.registry.
* `backend.py`    — abstract `ComputerUseBackend`; swappable implementation.
* `cua_backend.py`— default backend; speaks MCP over stdio to `cua-driver`.
* `schema.py`     — shared schema + docstring for the generic `computer_use`
                    tool. Model-agnostic.
"""

from __future__ import annotations

# Re-export the public surface so `from tools.computer_use import ...` works.
from tools.computer_use.tool import (  # noqa: F401
    handle_computer_use,
    set_approval_callback,
    check_computer_use_requirements,
    get_computer_use_schema,
)
