import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundle, createSession, PinnedCdn, preset } from "@unclarity/core";
import { capture } from "../src/index.js";

// Captures the live NOVA store and replays it to REAL Clarity so the dashboard shows the actual
// styled page. Gated: run with UNCLARITY_E2E=1.
describe.runIf(process.env.UNCLARITY_E2E === "1")("captured NOVA -> real Clarity", () => {
  it("replays a captured real page to live ingestion (all 2xx)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uc-e2e-"));
    await capture({ url: "https://nova.hackmap.win/", outDir: dir, waitUntil: "domcontentloaded", steps: [{ action: "wait", ms: 2000 }] });
    const bundle = await loadBundle(dir);

    const session = await createSession({
      projectId: "x9kvmle61a",
      bundle,
      url: "https://nova.hackmap.win/",
      profile: preset("win11-chrome"),
      provider: new PinnedCdn("0.8.65"),
    });
    session.scrollTo(500);
    session.scrollTo(1000);
    await session.end();
    session.close();

    const bad = session.uploadLog.filter((r) => r.status < 200 || r.status > 208);
    expect(bad, JSON.stringify(session.uploadLog)).toHaveLength(0);
  }, 60000);
});
