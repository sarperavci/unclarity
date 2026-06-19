import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decode } from "clarity-decode";
import { loadBundle, createSession, PinnedCdn, preset, type LoadedBundle } from "@unclarity/core";
import { capture } from "../src/index.js";

interface Decoded {
  dom?: Array<{ data: Array<{ tag: string }> }>;
}

// Capture is a real browser pass; gated off by default. Run with UNCLARITY_CAPTURE=1.
describe.runIf(process.env.UNCLARITY_CAPTURE === "1")("capture -> replay -> decode round-trip", () => {
  let server: Server;
  let bundle: LoadedBundle;
  let geoCount = 0;
  const payloads: Decoded[] = [];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "uc-capture-"));
    const manifest = await capture({ url: "https://nova.hackmap.win/", outDir: dir, waitUntil: "domcontentloaded", steps: [{ action: "wait", ms: 2000 }] });
    expect(manifest.geometryMode).toBe("captured");
    bundle = await loadBundle(dir);
    geoCount = Object.keys(bundle.geometry).length;

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
    const url = addr && typeof addr === "object" ? `http://127.0.0.1:${addr.port}/collect` : "";

    const session = await createSession({
      projectId: "x9kvmle61a",
      bundle,
      url: "https://nova.hackmap.win/",
      profile: preset("win11-chrome"),
      provider: new PinnedCdn("0.8.65"),
      upload: url,
    });
    session.scrollTo(600);
    await session.end();
    session.close();
  }, 60000);

  afterAll(() => server?.close());

  it("captures real per-node geometry", () => {
    expect(geoCount).toBeGreaterThan(20);
    expect(bundle.html.length).toBeGreaterThan(500);
  });

  it("replays the captured bundle and Clarity captures the DOM", () => {
    const nodes = payloads.flatMap((p) => p.dom ?? []).flatMap((e) => e.data);
    expect(nodes.length).toBeGreaterThan(20);
  });
});
