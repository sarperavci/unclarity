import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decode } from "clarity-decode";
import { authorBundle, loadBundle, validateBundle, createSession, PinnedCdn, preset } from "../src/index.js";

const HTML = `<!DOCTYPE html><html><head><title>NOVA</title>
<style>body{font-family:Arial}#add{background:#4f46e5;color:#fff;padding:12px}</style></head>
<body><header><a id="home" href="/">NOVA</a></header>
<main><h1 id="title">Aura Wireless Headphones</h1>
<button id="add" type="button">Add to cart</button></main></body></html>`;

interface Decoded {
  envelope: { sequence: number };
  dom?: Array<{ data: Array<{ tag: string; attributes?: Record<string, string> }> }>;
}

describe("manual-feed Bundle round-trip", () => {
  let server: Server;
  let url = "";
  let dir = "";
  const payloads: Decoded[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "uc-bundle-"));
    const manifest = await authorBundle({ html: HTML, sourceUrl: "https://nova.hackmap.win/p" }, dir);
    expect(manifest.geometryMode).toBe("inferred");
    await validateBundle(dir);
    const bundle = await loadBundle(dir);

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let buf = Buffer.concat(chunks);
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
        try {
          payloads.push(decode(buf.toString("utf8")) as unknown as Decoded);
        } catch {
          /* ignore */
        }
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr && typeof addr === "object") url = `http://127.0.0.1:${addr.port}/collect`;

    const session = await createSession({
      projectId: "x9kvmle61a",
      bundle,
      url: "https://nova.hackmap.win/p",
      profile: preset("win11-chrome"),
      provider: new PinnedCdn("0.8.65"),
      upload: url,
    });
    session.click("#add");
    await session.end();
    session.close();
  }, 30000);

  afterAll(() => server.close());

  it("replays the authored bundle and captures the DOM", () => {
    const nodes = payloads.flatMap((p) => p.dom ?? []).flatMap((e) => e.data);
    expect(nodes.some((n) => n.tag === "BUTTON")).toBe(true);
  });

  it("does NOT leak data-uc-id into the captured DOM", () => {
    const nodes = payloads.flatMap((p) => p.dom ?? []).flatMap((e) => e.data);
    const leaked = nodes.filter((n) => n.attributes && "data-uc-id" in n.attributes);
    expect(leaked).toHaveLength(0);
  });
});
