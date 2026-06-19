from __future__ import annotations

from typing import Any


class ScenarioBuilder:
    """Fluent scenario builder; compiles to the same JSON wire form as the Node builder."""

    def __init__(self) -> None:
        self._steps: list[dict[str, Any]] = []

    def wait(self, ms: int) -> "ScenarioBuilder":
        self._steps.append({"type": "wait", "ms": ms})
        return self

    def move(self, selector: str) -> "ScenarioBuilder":
        self._steps.append({"type": "move", "selector": selector})
        return self

    def click(self, selector: str) -> "ScenarioBuilder":
        self._steps.append({"type": "click", "selector": selector})
        return self

    def scroll_to(self, y: int) -> "ScenarioBuilder":
        self._steps.append({"type": "scrollTo", "y": y})
        return self

    def type(self, selector: str, text: str) -> "ScenarioBuilder":
        self._steps.append({"type": "type", "selector": selector, "text": text})
        return self

    def build(self) -> dict[str, Any]:
        return {"steps": list(self._steps)}

    def to_json(self) -> dict[str, Any]:
        return self.build()


def scenario() -> ScenarioBuilder:
    return ScenarioBuilder()
