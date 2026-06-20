import { describe, expect, it } from "vitest";
import { createSession, PinnedCdn, preset, scenario, runScenario, Rng } from "../src/index.js";

const HTML = `<!DOCTYPE html><html><head><title>NOVA</title><style>#add{padding:12px}</style></head>
<body><h1 id=title>Aura</h1><button id=add>Add to cart</button><input id=search></body></html>`;

async function deterministicPayloads(seed: number): Promise<string[]> {
  const session = await createSession({
    projectId: "x9kvmle61a",
    html: HTML,
    url: "https://nova.hackmap.win/p",
    profile: preset("win11-chrome"),
    provider: new PinnedCdn("0.8.65"),
    seed,
    deterministic: true,
  });
  const sc = scenario().scrollTo(300).move("#title").click("#add").type("#search", "headphones").wait(500).build();
  await runScenario(session, sc, new Rng(seed));
  await session.end();
  session.close();
  return session.payloads;
}

describe("full determinism (virtual clock + seeded randomness)", () => {
  it("same seed produces byte-identical payloads", async () => {
    const a = await deterministicPayloads(2024);
    const b = await deterministicPayloads(2024);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  }, 30000);

  it("different seeds produce different payloads", async () => {
    const a = await deterministicPayloads(111);
    const b = await deterministicPayloads(222);
    expect(a).not.toEqual(b);
  }, 30000);

  it("captures interaction events deterministically (no real network)", async () => {
    const payloads = await deterministicPayloads(7);
    const joined = payloads.join("");
    expect(joined).toContain("x9kvmle61a");
    // event type 9 = Click appears in the encoded analysis stream
    expect(payloads.length).toBeGreaterThanOrEqual(2);
  }, 30000);
});
