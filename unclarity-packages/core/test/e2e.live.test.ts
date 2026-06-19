import { describe, expect, it } from "vitest";
import { createSession, PinnedCdn, preset } from "../src/index.js";

const HTML = `<!DOCTYPE html><html><head><title>NOVA</title>
<style>body{font-family:Arial}#add{background:#4f46e5;color:#fff;padding:12px}</style></head>
<body><header><a id="home" href="/">NOVA</a></header>
<main><h1 id="title">Aura Wireless Headphones</h1><button id="add">Add to cart</button>
<input id="search" type="text" /></main></body></html>`;

// Release-gating smoke against real Clarity ingestion. Off by default; run with UNCLARITY_E2E=1.
describe.runIf(process.env.UNCLARITY_E2E === "1")("real Clarity ingestion", () => {
  it("uploads a complete session (all payloads 2xx)", async () => {
    const session = await createSession({
      projectId: "x9kvmle61a",
      html: HTML,
      url: "https://nova.hackmap.win/product.html?id=aura-headphones",
      profile: preset("win11-chrome"),
      provider: new PinnedCdn("0.8.65"),
      clarityConfig: { upgrade: undefined },
    });
    session.scrollTo(400);
    session.click("#add");
    session.type("#search", "wireless headphones");
    await session.end();
    session.close();

    expect(session.uploadLog.length).toBeGreaterThan(0);
    const bad = session.uploadLog.filter((r) => r.status < 200 || r.status > 208);
    expect(bad, JSON.stringify(session.uploadLog)).toHaveLength(0);
  }, 30000);
});
