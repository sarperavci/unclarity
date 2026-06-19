import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decode } from "clarity-decode";
import { createSession, PinnedCdn, preset } from "../src/index.js";

const STYLED_HTML = `<!DOCTYPE html><html><head><title>NOVA</title>
<style>body{font-family:Arial;margin:0}#add{background:#4f46e5;color:#fff;padding:12px 22px}</style></head>
<body><header><a id="home" href="/">NOVA</a></header>
<main><h1 id="title">Aura Wireless Headphones</h1>
<p>40-hour battery, adaptive noise cancelling.</p>
<button id="add" type="button">Add to cart</button>
<input id="search" type="text" /></main>
<footer><p>NOVA demo store</p></footer></body></html>`;

interface DecodedPayload {
  envelope: { sequence: number };
  dom?: Array<{ data: Array<{ tag: string; attributes?: Record<string, string> }> }>;
  click?: Array<{ data: { target: number } }>;
  dimension?: Array<{ data: Record<number, string[][]> }>;
}

describe("createSession against a local collector", () => {
  let server: Server;
  let url = "";
  const payloads: DecodedPayload[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let buf = Buffer.concat(chunks);
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
        try {
          payloads.push(decode(buf.toString("utf8")) as unknown as DecodedPayload);
        } catch {
          /* ignore non-payload requests */
        }
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr && typeof addr === "object") url = `http://127.0.0.1:${addr.port}/collect`;

    const session = await createSession({
      projectId: "x9kvmle61a",
      html: STYLED_HTML,
      url: "https://nova.hackmap.win/product.html?id=aura-headphones",
      profile: preset("win11-chrome"),
      provider: new PinnedCdn("0.8.65"),
      upload: url,
    });
    session.scrollTo(400);
    session.move("#title");
    session.click("#add");
    session.type("#search", "wireless headphones");
    await session.end();
    session.close();
  }, 30000);

  afterAll(() => {
    server.close();
  });

  it("captures the full DOM tree (not just a few nodes)", () => {
    const domNodes = payloads.flatMap((p) => p.dom ?? []).flatMap((e) => e.data);
    expect(domNodes.length).toBeGreaterThan(15);
    expect(domNodes.some((n) => n.tag === "BUTTON")).toBe(true);
    expect(domNodes.some((n) => n.tag === "STYLE")).toBe(true);
  });

  it("resolves click targets to real node ids (not 0)", () => {
    const clicks = payloads.flatMap((p) => p.click ?? []);
    expect(clicks.length).toBeGreaterThan(0);
    expect(clicks.every((c) => c.data.target > 0)).toBe(true);
  });

  it("reports the Chrome user-agent dimension", () => {
    const json = JSON.stringify(payloads);
    expect(json).toContain("Chrome/132");
  });

  it("decodes every captured payload", () => {
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(payloads.every((p) => typeof p.envelope?.sequence === "number")).toBe(true);
  });
});
