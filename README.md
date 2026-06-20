# unclarity 🌫️

> The evil twin of Microsoft Clarity — it drives Microsoft's **own** `clarity.js`, browserless, to mint **synthetic** analytics sessions that look completely real in the Clarity dashboard.

## What is this?

[Microsoft Clarity](https://clarity.microsoft.com) is a behavioral-analytics library: you drop `clarity.js` on a page, a real visitor browses, and their session — browser, device, OS, page geometry, heatmaps, session replay — shows up in your dashboard.

**unclarity** is its mischievous extension. It produces those exact same sessions **without a visitor and without a browser at runtime**. It takes Microsoft's *real, unmodified* `clarity.js`, runs it inside a Node DOM realm, replays a page plus a sequence of user actions against it, and lets the genuine library do its job: encode, compress, and upload. The result is a synthetic session that is indistinguishable from an organic one in the Clarity UI.

Crucially: **there is no payload forging.** unclarity never hand-writes a fake telemetry blob — it runs the authentic `encode → compress → upload` pipeline, so every payload is valid by construction. An evil twin, but a well-behaved one under the hood: strictly-typed, golden-vector-tested, and deterministic.

## How it works

```
Bundle  (a page: DOM + CSS + per-node geometry)
  ├─ author by hand (primary)        authorBundle() / unclarity bundle
  └─ capture any URL (offline, 1×)   @unclarity/capture (Playwright, auth-aware)
        │
        ▼
Session  (pure Node — no browser at runtime)
  jsdom realm + browser shims + DeviceProfile + geometry oracle
  + Microsoft's real clarity.js  (PinnedCdn default / LiveCdn)
        │
        ▼
Real encoded uploads → t.clarity.ms/collect  →  appears in your Clarity dashboard
```

You first obtain a **Bundle** — a self-contained page snapshot (DOM, CSS, per-node geometry). Author one by hand, or capture any real URL once, offline, with the auth-aware Playwright capturer. From then on sessions run in **pure Node, no browser**: a jsdom realm with browser shims, a device profile, and a geometry oracle, hosting the genuine `clarity.js`.

Making Microsoft's library run unmodified took some hard-won jsdom work — shimming `document.adoptedStyleSheets` (without it the whole DOM is dropped), normalizing synthetic event `timeStamp` to be `performance.timeOrigin`-relative (else payloads are rejected), and supplying a geometry oracle (jsdom has no layout engine).

## Capabilities

- **Page replication** — author a Bundle by hand, or capture any URL offline (one browser run, auth-aware) and replay it forever browserless.
- **Device fingerprints & presets** — coherent viewport, UA, client hints, DPR, touch. Presets: `win11-chrome`, `win11-edge`, `iphone15-safari`, `pixel8-chrome`.
- **Seeded realism engine** — scripted scroll/click/type with decimated human mouse paths and gaussian click placement; `seed` makes userId/sessionId reproducible.
- **Full byte-level determinism** — `deterministic: true` engages a VirtualClock that virtualizes `setTimeout`/`performance`/`Date`/`Math.random`; the same seed yields **byte-identical payloads** run to run (and runs fast, since virtual time skips real waits).
- **HTTP + SOCKS proxies** — HTTP/HTTPS via undici `ProxyAgent`, SOCKS4/5 (`socks://`) via a TLS-upgrading agent; pools rotate egress IP per session.
- **Node + Python APIs** — first-class on both, parity enforced by frozen golden vectors.
- **Always-latest, safely** — `PinnedCdn` (default, reproducible) or `LiveCdn`; a CI **compatibility canary** detects new Clarity versions, auto-PRs a bump when still compatible, and opens a drift issue (never silently degrades) when not.

## Node

```ts
import { run, scenario, preset, PinnedCdn } from "@unclarity/core";

// one-time, offline:  npx unclarity capture https://shop.example.com/p -o ./bundle --device win11-chrome
const sc = scenario().scrollTo(600).click("#add-to-cart").type("#search", "headphones").build();

for await (const r of run({
  projectId: "xxxxxxxxxx",
  url: "https://shop.example.com/p",
  bundleDir: "./bundle",          // or html: "<!doctype html>…"
  profile: "win11-chrome",
  scenario: sc,
  count: 50, concurrency: 8, seed: 42,
  clarity: { source: "pinned", version: "0.8.65" },
  network: { proxy: { pool: ["socks5://user:pass@host:1080"], rotate: "per-session" } },
})) {
  console.log(r.index, r.verdict, r.clarityVersion);
}
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
# async:  async for r in uc.run(...).astream(): ...
```

The Python wheel spawns the Node CLI and exchanges newline-delimited JSON over stdio (`UNCLARITY_NODE` / `UNCLARITY_CLI` override discovery).

## Built on Microsoft Clarity

This repository is a **fork of [microsoft/clarity](https://github.com/microsoft/clarity)**. The upstream packages under [`packages/`](./packages) are kept **byte-for-byte pristine** and consumed as-is; everything unclarity adds lives in [`unclarity-packages/`](./unclarity-packages) (TypeScript: core + capture) and [`python/`](./python). A weekly workflow syncs upstream so the reference + `LocalFork` provider stay current.

- 📦 This repo: **https://github.com/sarperavci/unclarity**
- 🔬 Upstream: **https://github.com/microsoft/clarity**
- 📖 Deep docs & design: **[UNCLARITY.md](./UNCLARITY.md)**

## Responsible use

unclarity is for **testing and debugging your own Clarity projects** — verifying dashboards, exercising heatmaps, building reproducible analytics fixtures. Point it at projects you own, keep volume modest, and don't use it to pollute or attack third-party analytics. Be a good evil twin.

---

<sub>The original Microsoft Clarity README is preserved at [`README.clarity.md`](./README.clarity.md).</sub>
