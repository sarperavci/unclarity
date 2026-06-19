import { describe, expect, it } from "vitest";
import { PRESETS, preset, validateProfile, profileHeaders, type DeviceProfile } from "../src/index.js";

describe("device presets", () => {
  it("all presets are internally coherent", () => {
    for (const id of Object.keys(PRESETS)) {
      expect(() => validateProfile(preset(id))).not.toThrow();
    }
  });

  it("Chromium presets carry uaData; Safari does not", () => {
    expect(preset("win11-chrome").uaData).toBeDefined();
    expect(preset("pixel8-chrome").uaData?.mobile).toBe(true);
    expect(preset("iphone15-safari").uaData).toBeUndefined();
  });

  it("transport headers match navigator UA byte-for-byte", () => {
    const p = preset("win11-edge");
    const h = profileHeaders(p, "https://x.test", "https://x.test/page");
    expect(h["user-agent"]).toBe(p.userAgent);
    expect(h["sec-ch-ua"]).toContain("Microsoft Edge");
  });

  it("rejects an incoherent profile", () => {
    const { uaData: _omit, ...bad } = preset("win11-chrome");
    void _omit;
    expect(() => validateProfile(bad as DeviceProfile)).toThrow();
  });

  it("mobile UA must declare touch points", () => {
    const p = preset("iphone15-safari");
    expect(p.maxTouchPoints).toBeGreaterThan(0);
  });
});
