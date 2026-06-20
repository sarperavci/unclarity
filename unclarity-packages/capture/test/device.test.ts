import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundle } from "@unclarity/core";
import { capture } from "../src/index.js";

// Mobile capture via a device preset. Gated: run with UNCLARITY_CAPTURE=1.
describe.runIf(process.env.UNCLARITY_CAPTURE === "1")("capture with a device preset", () => {
  it("captures NOVA as iPhone (mobile viewport + geometry)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uc-mobile-"));
    const manifest = await capture({
      url: "https://nova.hackmap.win/",
      outDir: dir,
      device: "iphone15-safari",
      waitUntil: "domcontentloaded",
      steps: [{ action: "wait", ms: 1500 }],
    });
    expect(manifest.viewport.width).toBeLessThan(500); // mobile viewport
    expect(manifest.dpr).toBeGreaterThan(1);
    const bundle = await loadBundle(dir);
    expect(Object.keys(bundle.geometry).length).toBeGreaterThan(10);
  }, 60000);
});
