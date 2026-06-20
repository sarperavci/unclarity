# unclarity

Generate **synthetic Microsoft Clarity sessions** — browserless at runtime — by driving Microsoft's
**real** `clarity.js` inside a Node DOM shim. No payload forging: the genuine encode → compress →
upload pipeline runs, so payloads are always valid and sessions appear correctly in the Clarity
dashboard (browser, device, OS, geometry, heatmaps). Programmable from **Node and Python**.

> Built additively on a fork of [microsoft/clarity](https://github.com/microsoft/clarity). The
> upstream packages under `packages/` are kept pristine and consumed as-is; all unclarity code lives
> in `unclarity-packages/` and `python/`.

## How it works

```
Bundle (a page: DOM + CSS + per-node geometry)
  ├─ author by hand (primary)        unclarity bundle / authorBundle()
  └─ capture any URL (offline, 1×)   @unclarity/capture (Playwright, auth-aware)
        │
        ▼
Session (pure Node, no browser): jsdom realm + shims + DeviceProfile + geometry oracle
  + real clarity.js (PinnedCdn default / LiveCdn) → real encoded uploads → t.clarity.ms/collect
```

The hard-won jsdom integration fixes (so Microsoft's library runs unmodified): shim
`document.adoptedStyleSheets` (else the whole DOM is dropped), normalize synthetic event
`timeStamp` to be `performance.timeOrigin`-relative (else payloads are rejected), and a geometry
oracle (jsdom has no layout engine).

## Node

```ts
import { run, scenario, preset, PinnedCdn } from "@unclarity/core";

const sc = scenario().scrollTo(600).click("#add-to-cart").type("#search", "headphones").build();
for await (const r of run({
  projectId: "xxxxxxxxxx",
  url: "https://shop.example.com/p",
  bundleDir: "./bundle",          // or html: "<!doctype html>..."
  profile: "win11-chrome",
  scenario: sc,
  count: 50, concurrency: 8, seed: 42,
  clarity: { source: "pinned", version: "0.8.65" },
  network: { proxy: { pool: ["http://user:pass@host:8080"], rotate: "per-session" } },
})) {
  console.log(r.index, r.verdict, r.clarityVersion);
}
```

Capture a page first (offline, one browser):

```bash
npx unclarity capture https://shop.example.com/p -o ./bundle --storage-state auth.json
```

## Python

```python
from unclarity import Unclarity, scenario, preset

uc = Unclarity()
sc = scenario().scroll_to(600).click("#add-to-cart").type("#search", "headphones")
for r in uc.run(project_id="xxxxxxxxxx", url="https://shop.example.com/p",
                bundle_dir="./bundle", profile=preset("win11-chrome"),
                scenario=sc, count=50, concurrency=8, seed=42).stream():
    print(r.index, r.verdict)
# async: `async for r in uc.run(...).astream(): ...`
```

The Python wheel spawns the Node CLI (`node dist/cli.js run`) and exchanges newline-delimited JSON
over stdio. Set `UNCLARITY_NODE` / `UNCLARITY_CLI` to override discovery.

## Compatibility

`PinnedCdn` (default) replays a fixed `clarity.js` version for reproducible bytes. `LiveCdn` detects
and loads the version Microsoft currently serves — and **refuses loudly** (`VersionFetchFailed`) on
detection failure rather than silently falling back. `parseTagConfig()` mirrors a project's real
cookie/dob config for fidelity.

## Quality

- Strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `mypy --strict` Python.
- Tier-2 integration tests decode payloads with the real `clarity-decode` against a local collector;
  gated Tier-3 e2e hits live ingestion.
- Seeded PRNG with frozen golden vectors (Node ↔ Python parity).
- All test/runner commands run under the machine's `safetest` memory wrapper.

## Determinism & identity

Pass `seed` to make a session's **userId/sessionId reproducible** (seeded `crypto.getRandomValues`;
`crypto.subtle` stays real). The PRNG and realism generators are fully deterministic. Full
session-level *byte* determinism (timestamps) still needs a VirtualClock — planned.

## Proxies

`network.proxy` accepts HTTP/HTTPS (undici `ProxyAgent`) **and SOCKS4/5** (`socks://`,
tunnelled via a custom undici `Agent` with TLS upgrade). A `pool` with `rotate: "per-session"`
gives each session a different egress IP.

## Capture devices

`capture({ device: "iphone15-safari" })` sets viewport, UA, DPR, and mobile/touch coherently
(also `--device` on the CLI). Presets: `win11-chrome`, `win11-edge`, `iphone15-safari`,
`pixel8-chrome`.

## Known limitations

- Capture replicates a *captured/authored state* at the chosen viewport — not arbitrary
  post-scroll/lazy geometry. Multi-keyframe SPA capture is a future extension.
- Full byte-identical session determinism awaits a VirtualClock (timestamps vary per run today).

This is a testing/debugging tool for your **own** Clarity projects. Keep volume modest.
