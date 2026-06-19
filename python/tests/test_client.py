from __future__ import annotations

import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from unclarity import Unclarity, preset, scenario

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
