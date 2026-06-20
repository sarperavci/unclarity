from __future__ import annotations

import asyncio
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from unclarity import Unclarity, preset, scenario
from unclarity.client import SessionResult

HTML = (
    "<!DOCTYPE html><html><head><title>NOVA</title><style>#add{padding:12px}</style></head>"
    "<body><h1 id=title>Aura</h1><button id=add>Add</button><input id=search></body></html>"
)


class _Collector(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", 0))
        self.rfile.read(length)
        self.server.hits += 1  # type: ignore[attr-defined]
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_: object) -> None:
        pass


def _collector() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Collector)
    server.hits = 0  # type: ignore[attr-defined]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/collect"


def _make_run(upload: str, count: int = 2):
    uc = Unclarity()
    sc = scenario().scroll_to(300).move("#title").click("#add").type("#search", "headphones")
    return uc.run(
        project_id="x9kvmle61a",
        url="https://nova.hackmap.win/p",
        html=HTML,
        profile=preset("win11-chrome"),
        scenario=sc,
        count=count,
        concurrency=2,
        seed=5,
        upload=upload,
    )


def test_sync_run_all_ok() -> None:
    server, url = _collector()
    try:
        results = _make_run(url, count=2).results()
        assert len(results) == 2
        assert all(r.verdict == "ok" for r in results), results
        assert all(r.clarity_version == "0.8.65" for r in results)
        assert server.hits > 2  # type: ignore[attr-defined]
    finally:
        server.shutdown()


def test_async_stream() -> None:
    server, url = _collector()

    async def go() -> int:
        n = 0
        async for r in _make_run(url, count=2).astream():
            assert r.verdict == "ok"
            n += 1
        return n

    try:
        assert asyncio.run(go()) == 2
    finally:
        server.shutdown()


# --- edge-case coverage via a fake CLI (python script in place of node <cli> run) ---


def _fake_cli(tmp_path: Path, body: str) -> Unclarity:
    """A Unclarity wired to a python "CLI" so we can script stdout/stderr/exit code."""
    script = tmp_path / "fake_cli.py"
    script.write_text("import sys, json\nreq = json.loads(sys.stdin.read())\n" + body)
    return Unclarity(node=sys.executable, cli=str(script))


def _run(uc: Unclarity):  # type: ignore[no-untyped-def]
    return uc.run(project_id="p", url="u", profile=preset("win11-chrome"), scenario=scenario(), count=1)


def test_from_json_tolerates_missing_fields() -> None:
    r = SessionResult.from_json({})
    assert r.index == -1
    assert r.verdict == ""
    assert r.uploads == 0


def test_skips_malformed_json_lines(tmp_path: Path) -> None:  # C5
    body = (
        'sys.stdout.write("not json at all\\n")\n'
        'sys.stdout.write(json.dumps({"type":"result","index":0,"verdict":"ok"}) + "\\n")\n'
        'sys.stdout.write("{broken json\\n")\n'
        'sys.stdout.write(json.dumps({"type":"done","failed":0}) + "\\n")\n'
        "sys.exit(0)\n"
    )
    results = _run(_fake_cli(tmp_path, body)).results()
    assert len(results) == 1
    assert results[0].verdict == "ok"


def test_summary_exposed(tmp_path: Path) -> None:  # S4
    body = (
        'sys.stdout.write(json.dumps({"type":"result","index":0,"verdict":"failed"}) + "\\n")\n'
        'sys.stdout.write(json.dumps({"type":"done","failed":1}) + "\\n")\n'
        "sys.exit(1)\n"
    )
    run = _run(_fake_cli(tmp_path, body))
    results = run.results()
    assert len(results) == 1
    assert run.summary is not None
    assert run.summary.failed == 1


def test_crash_before_results_surfaces_stderr(tmp_path: Path) -> None:  # C7
    body = 'sys.stderr.write("boom: provider unreachable\\n")\nsys.exit(1)\n'
    with pytest.raises(RuntimeError) as ei:
        _run(_fake_cli(tmp_path, body)).results()
    assert "boom: provider unreachable" in str(ei.value)


def test_usage_error_raises(tmp_path: Path) -> None:
    body = 'sys.stderr.write("usage: unclarity <run|capture>\\n")\nsys.exit(2)\n'
    with pytest.raises(RuntimeError) as ei:
        _run(_fake_cli(tmp_path, body)).results()
    assert "exited 2" in str(ei.value)


def test_failed_sessions_do_not_raise(tmp_path: Path) -> None:
    body = (
        'sys.stdout.write(json.dumps({"type":"result","index":0,"verdict":"failed"}) + "\\n")\n'
        'sys.stdout.write(json.dumps({"type":"done","failed":1}) + "\\n")\n'
        "sys.exit(1)\n"
    )
    results = _run(_fake_cli(tmp_path, body)).results()
    assert results[0].verdict == "failed"


def test_no_deadlock_on_large_stderr(tmp_path: Path) -> None:  # H5
    body = (
        'sys.stderr.write("x" * (2 * 1024 * 1024))\n'
        'sys.stderr.flush()\n'
        'for i in range(3):\n'
        '    sys.stdout.write(json.dumps({"type":"result","index":i,"verdict":"ok"}) + "\\n")\n'
        '    sys.stdout.flush()\n'
        'sys.stdout.write(json.dumps({"type":"done","failed":0}) + "\\n")\n'
        "sys.exit(0)\n"
    )
    results = _run(_fake_cli(tmp_path, body)).results()
    assert len(results) == 3


def test_early_break_reaps_child(tmp_path: Path) -> None:  # H6
    body = (
        'import time\n'
        'for i in range(100):\n'
        '    sys.stdout.write(json.dumps({"type":"result","index":i,"verdict":"ok"}) + "\\n")\n'
        '    sys.stdout.flush()\n'
        '    time.sleep(0.05)\n'
    )
    run = _run(_fake_cli(tmp_path, body))
    gen = run.stream()
    first = next(gen)
    assert first.index == 0
    gen.close()  # GeneratorExit -> must terminate the child without raising on its signal code


def test_async_large_line(tmp_path: Path) -> None:  # S1
    big = "z" * (200 * 1024)
    body = (
        f'sys.stdout.write(json.dumps({{"type":"result","index":0,"verdict":"ok","error":"{big}"}}) + "\\n")\n'
        'sys.stdout.write(json.dumps({"type":"done","failed":0}) + "\\n")\n'
        "sys.exit(0)\n"
    )
    uc = _fake_cli(tmp_path, body)

    async def go() -> SessionResult:
        out: list[SessionResult] = []
        async for r in _run(uc).astream():
            out.append(r)
        return out[0]

    r = asyncio.run(go())
    assert r.error is not None and len(r.error) == 200 * 1024


def test_async_crash_raises(tmp_path: Path) -> None:  # C2 + C7
    body = 'sys.stderr.write("async boom\\n")\nsys.exit(1)\n'
    uc = _fake_cli(tmp_path, body)

    async def go() -> None:
        async for _ in _run(uc).astream():
            pass

    with pytest.raises(RuntimeError) as ei:
        asyncio.run(go())
    assert "async boom" in str(ei.value)
