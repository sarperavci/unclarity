from __future__ import annotations

import asyncio
import json
import subprocess
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from typing import Any

from ._locate import cli_entry, node_binary
from .scenario import ScenarioBuilder


@dataclass(frozen=True)
class SessionResult:
    index: int
    clarity_version: str
    bundle_source: str
    verdict: str
    uploads: int
    ok: int
    duration_ms: int
    egress: str | None = None
    error: str | None = None

    @staticmethod
    def from_json(d: dict[str, Any]) -> "SessionResult":
        return SessionResult(
            index=d["index"],
            clarity_version=d.get("clarityVersion", ""),
            bundle_source=d.get("bundleSource", ""),
            verdict=d["verdict"],
            uploads=d.get("uploads", 0),
            ok=d.get("ok", 0),
            duration_ms=d.get("durationMs", 0),
            egress=d.get("egress"),
            error=d.get("error"),
        )


def _build_request(
    *,
    project_id: str,
    url: str,
    profile: str,
    scenario: ScenarioBuilder | dict[str, Any],
    count: int = 1,
    concurrency: int = 1,
    seed: int = 1,
    bundle_dir: str | None = None,
    html: str | None = None,
    upload: str | None = None,
    clarity: dict[str, Any] | None = None,
    network: dict[str, Any] | None = None,
) -> dict[str, Any]:
    sc = scenario.build() if isinstance(scenario, ScenarioBuilder) else scenario
    req: dict[str, Any] = {
        "projectId": project_id,
        "url": url,
        "profile": profile,
        "scenario": sc,
        "count": count,
        "concurrency": concurrency,
        "seed": seed,
    }
    if bundle_dir is not None:
        req["bundleDir"] = bundle_dir
    if html is not None:
        req["html"] = html
    if upload is not None:
        req["upload"] = upload
    if clarity is not None:
        req["clarity"] = clarity
    if network is not None:
        req["network"] = network
    return req


class Run:
    def __init__(self, node: str, cli: str, request: dict[str, Any]) -> None:
        self._node = node
        self._cli = cli
        self._request = request

    def stream(self) -> Iterator[SessionResult]:
        """Synchronously stream results as each session completes."""
        proc = subprocess.Popen(
            [self._node, self._cli, "run"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert proc.stdin and proc.stdout
        proc.stdin.write(json.dumps(self._request))
        proc.stdin.close()
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            if msg.get("type") == "result":
                yield SessionResult.from_json(msg)
        err = proc.stderr.read() if proc.stderr else ""
        code = proc.wait()
        if code not in (0, 1):  # 1 = some sessions failed (results already streamed)
            raise RuntimeError(f"unclarity CLI exited {code}: {err.strip()}")

    def results(self) -> list[SessionResult]:
        return list(self.stream())

    async def astream(self) -> AsyncIterator[SessionResult]:
        """Asynchronously stream results."""
        proc = await asyncio.create_subprocess_exec(
            self._node,
            self._cli,
            "run",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert proc.stdin and proc.stdout
        proc.stdin.write(json.dumps(self._request).encode())
        proc.stdin.close()
        async for raw in proc.stdout:
            line = raw.decode().strip()
            if not line:
                continue
            msg = json.loads(line)
            if msg.get("type") == "result":
                yield SessionResult.from_json(msg)
        await proc.wait()


class Unclarity:
    """Entry point: spawns the vendored Node CLI per run (subprocess over stdio)."""

    def __init__(self, node: str | None = None, cli: str | None = None) -> None:
        self._node = node or node_binary()
        self._cli = cli or cli_entry()

    def run(self, **kwargs: Any) -> Run:
        return Run(self._node, self._cli, _build_request(**kwargs))
