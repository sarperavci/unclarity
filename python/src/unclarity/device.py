from __future__ import annotations

PRESETS = frozenset({"win11-chrome", "win11-edge", "iphone15-safari", "pixel8-chrome"})


def preset(profile_id: str) -> str:
    """Validate and return a device preset id (mirrors @unclarity/core presets)."""
    if profile_id not in PRESETS:
        raise ValueError(f"unknown device preset: {profile_id!r}. Known: {sorted(PRESETS)}")
    return profile_id
