from __future__ import annotations

import asyncio
import json
import subprocess
import threading
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from typing import Any

from ._locate import cli_entry, node_binary
from .scenario import ScenarioBuilder

# asyncio StreamReader default line limit is 64 KiB; a single result line can exceed that.
_STREAM_LIMIT = 8 * 1024 * 1024


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
            index=d.get("index", -1),
            clarity_version=d.get("clarityVersion", ""),
            bundle_source=d.get("bundleSource", ""),
            verdict=d.get("verdict", ""),
            uploads=d.get("uploads", 0),
            ok=d.get("ok", 0),
            duration_ms=d.get("durationMs", 0),
            egress=d.get("egress"),
            error=d.get("error"),
        )


@dataclass(frozen=True)
class RunSummary:
    """The final {"type":"done", failed} the CLI emits after all results."""

    failed: int


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


def _check_exit(code: int, got_results: bool, stderr: str) -> None:
    """Raise unless the CLI ran cleanly.

    Exit 0 = all sessions ok. Exit 1 = some sessions failed (their results were already streamed; see
    Run.summary) — tolerated only when results were streamed. Any nonzero exit with NO results is a
    real crash (bad request, usage error, internal throw) and raises with the captured stderr.
    """
    if got_results and code in (0, 1):
        return
    if code == 0:
        return
    raise RuntimeError(f"unclarity CLI exited {code}: {stderr.strip()}")


class Run:
    def __init__(self, node: str, cli: str, request: dict[str, Any]) -> None:
        self._node = node
        self._cli = cli
        self._request = request
        self._summary: RunSummary | None = None

    @property
    def summary(self) -> RunSummary | None:
        """Final summary emitted by the CLI; populated once a stream is fully consumed."""
        return self._summary

    def _dispatch(self, line: str) -> SessionResult | None:
        """Parse one stdout line: return a SessionResult for `result`, capture `done`, else None.

        Tolerates blank / non-JSON lines (stdout should carry only JSON). Shared by stream/astream so
        the parse+dispatch contract lives in exactly one place.
        """
        line = line.strip()
        if not line:
            return None
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            return None
        kind = msg.get("type")
        if kind == "result":
            return SessionResult.from_json(msg)
        if kind == "done":
            self._summary = RunSummary(failed=int(msg.get("failed", 0)))
        return None

    def stream(self) -> Iterator[SessionResult]:
        """Synchronously stream results as each session completes."""
        proc = subprocess.Popen(
            [self._node, self._cli, "run"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert proc.stdin and proc.stdout and proc.stderr

        # H5: drain stderr concurrently so a chatty child can't deadlock us while we read stdout.
        stderr_chunks: list[str] = []
        stderr_pipe = proc.stderr
        drain = threading.Thread(target=lambda: stderr_chunks.append(stderr_pipe.read()), daemon=True)
        drain.start()

        got_results = False
        drained_fully = False
        try:
            proc.stdin.write(json.dumps(self._request))
            proc.stdin.close()
            for line in proc.stdout:
                result = self._dispatch(line)
                if result is not None:
                    got_results = True
                    yield result
            drained_fully = True
        finally:
            # H6: always reap the child and close pipes, even on early break / GeneratorExit.
            terminated = False
            if proc.poll() is None:
                terminated = True
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
            code = proc.wait()
            drain.join(timeout=5)
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                if pipe is not None:
                    pipe.close()
            err = stderr_chunks[0] if stderr_chunks else ""
            # Only judge the exit code when the child finished on its own. If we killed it
            # (consumer broke the generator early) its code is meaningless.
            if drained_fully and not terminated:
                _check_exit(code, got_results, err)

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
            limit=_STREAM_LIMIT,  # S1: large result lines exceed the 64 KiB default
        )
        assert proc.stdin and proc.stdout and proc.stderr

        # H5: drain stderr concurrently in a background task.
        stderr_buf = bytearray()
        stdout = proc.stdout
        stderr = proc.stderr

        async def _drain() -> None:
            async for chunk in stderr:
                stderr_buf.extend(chunk)

        drain_task = asyncio.create_task(_drain())

        got_results = False
        drained_fully = False
        try:
            proc.stdin.write(json.dumps(self._request).encode())
            proc.stdin.close()
            async for raw in stdout:
                result = self._dispatch(raw.decode("utf-8", "replace"))
                if result is not None:
                    got_results = True
                    yield result
            drained_fully = True
        finally:
            # H6: always reap the child, even on early break / GeneratorExit.
            terminated = False
            if proc.returncode is None:
                terminated = True
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5)
                except (asyncio.TimeoutError, ProcessLookupError):
                    if proc.returncode is None:
                        proc.kill()
            code = await proc.wait()
            await drain_task
            err = stderr_buf.decode("utf-8", "replace")
            if drained_fully and not terminated:
                _check_exit(code, got_results, err)  # C2: async honors the exit code too


class Unclarity:
    """Entry point: spawns the vendored Node CLI per run (subprocess over stdio)."""

    def __init__(self, node: str | None = None, cli: str | None = None) -> None:
        self._node = node or node_binary()
        self._cli = cli or cli_entry()

    def run(self, **kwargs: Any) -> Run:
        return Run(self._node, self._cli, _build_request(**kwargs))
