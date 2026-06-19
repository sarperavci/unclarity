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
    """Locate the compiled CLI. UNCLARITY_CLI override, else the vendored/sibling core build."""
    override = os.environ.get("UNCLARITY_CLI")
    if override:
        return override
    # repo layout: python/src/unclarity/_locate.py -> repo/unclarity-packages/core/dist/cli.js
    repo_root = Path(__file__).resolve().parents[3]
    candidate = repo_root / "unclarity-packages" / "core" / "dist" / "cli.js"
    if candidate.exists():
        return str(candidate)
    # vendored layout: package data alongside this file
    vendored = Path(__file__).resolve().parent / "_vendor" / "cli.js"
    if vendored.exists():
        return str(vendored)
    raise RuntimeError("unclarity CLI not found. Build @unclarity/core (npm run build) or set UNCLARITY_CLI.")
