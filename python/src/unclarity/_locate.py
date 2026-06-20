from __future__ import annotations

import os
import shutil
from pathlib import Path


def node_binary() -> str:
    """Locate the Node runtime: UNCLARITY_NODE override, else PATH."""
    override = os.environ.get("UNCLARITY_NODE")
    if override:
        return override
    found = shutil.which("node")
    if not found:
        raise RuntimeError("node>=26 not found. Set UNCLARITY_NODE or add node to PATH.")
    return found


def cli_entry() -> str:
    """Locate the compiled CLI: UNCLARITY_CLI override, vendored copy, else the sibling core build.

    Walks up from this file looking for ``unclarity-packages/core/dist/cli.js`` (marker-based, so it
    survives directory-depth changes) before giving up.
    """
    override = os.environ.get("UNCLARITY_CLI")
    if override:
        return override
    # vendored layout: package data alongside this file (how the wheel ships).
    vendored = Path(__file__).resolve().parent / "_vendor" / "cli.js"
    if vendored.exists():
        return str(vendored)
    # dev layout: walk up to the repo and find the sibling core build.
    rel = Path("unclarity-packages") / "core" / "dist" / "cli.js"
    for parent in Path(__file__).resolve().parents:
        candidate = parent / rel
        if candidate.exists():
            return str(candidate)
    raise RuntimeError("unclarity CLI not found. Build @unclarity/core (npm run build) or set UNCLARITY_CLI.")
