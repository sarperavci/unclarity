import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decode } from "clarity-decode";
import { createSession, PinnedCdn, preset } from "../src/index.js";

const HTML = `<!DOCTYPE html><html><head><title>NOVA</title></head><body><button id=add>Add</button></body></html>`;

interface Decoded {
  envelope: { userId?: string; sessionId?: string };
}

async function runOnce(seed: number, url: string): Promise<{ userId?: string; sessionId?: string }> {
  const session = await createSession({
    projectId: "x9kvmle61a",
    html: HTML,
    url: "https://nova.hackmap.win/p",
    profile: preset("win11-chrome"),
    provider: new PinnedCdn("0.8.65"),
    upload: url,
    seed,
  });
  session.click("#add");
  await session.end();
  session.close();
  return waitFor();
}

let received: Decoded[] = [];
function waitFor(): { userId?: string; sessionId?: string } {
  const env = received[0]?.envelope ?? {};
  received = [];
  return { ...(env.userId !== undefined ? { userId: env.userId } : {}), ...(env.sessionId !== undefined ? { sessionId: env.sessionId } : {}) };
}

describe("seeded session identity", () => {
  let server: Server;
  let url = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let buf = Buffer.concat(chunks);
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
        try {
          received.push(decode(buf.toString("utf8")) as unknown as Decoded);
        } catch {
          /* ignore */
        }
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr && typeof addr === "object") url = `http://127.0.0.1:${addr.port}/collect`;
  });

  afterAll(() => server.close());

  it("same seed reproduces the same userId", async () => {
    const a = await runOnce(777, url);
    const b = await runOnce(777, url);
    expect(a.userId).toBeDefined();
    expect(a.userId).toBe(b.userId);
  }, 30000);

  it("different seeds produce different userIds", async () => {
    const a = await runOnce(1001, url);
    const b = await runOnce(2002, url);
    expect(a.userId).not.toBe(b.userId);
  }, 30000);
});
