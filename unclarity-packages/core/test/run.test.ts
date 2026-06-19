import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, scenario, type SessionResult } from "../src/index.js";

const HTML = `<!DOCTYPE html><html><head><title>NOVA</title><style>#add{padding:12px}</style></head>
<body><h1 id="title">Aura</h1><button id="add">Add to cart</button><input id="search"/></body></html>`;

describe("run() concurrency pool", () => {
  let server: Server;
  let url = "";
  let count = 0;
  const results: SessionResult[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        count++;
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr && typeof addr === "object") url = `http://127.0.0.1:${addr.port}/collect`;

    const sc = scenario().scrollTo(300).move("#title").click("#add").type("#search", "headphones").build();
    for await (const result of run({
      projectId: "x9kvmle61a",
      url: "https://nova.hackmap.win/p",
      html: HTML,
      profile: "win11-chrome",
      scenario: sc,
      count: 3,
      concurrency: 2,
      seed: 42,
      upload: url,
    })) {
      results.push(result);
    }
  }, 40000);

  afterAll(() => server.close());

  it("runs the requested number of sessions", () => {
    expect(results).toHaveLength(3);
  });

  it("every session succeeds (verdict ok, all uploads 2xx)", () => {
    for (const r of results) {
      expect(r.verdict, JSON.stringify(r)).toBe("ok");
      expect(r.uploads).toBeGreaterThan(0);
      expect(r.ok).toBe(r.uploads);
      expect(r.clarityVersion).toBe("0.8.65");
    }
  });

  it("sent payloads to the collector", () => {
    expect(count).toBeGreaterThan(3);
  });
});
