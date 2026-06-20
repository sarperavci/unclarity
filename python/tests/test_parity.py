from __future__ import annotations

import json
from pathlib import Path

from unclarity.device import PRESETS

# schemas/ is the cross-language contract; assert the Python preset list matches it (the TS side is
# guarded by core/test/parity.test.ts).
_SCHEMAS = Path(__file__).resolve().parents[2] / "schemas"


def test_device_presets_match_schema() -> None:
    schema = json.loads((_SCHEMAS / "run-request.schema.json").read_text())
    enum = set(schema["properties"]["profile"]["enum"])
    assert set(PRESETS) == enum
