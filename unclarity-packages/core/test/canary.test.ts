import { describe, expect, it } from "vitest";
import { canaryExitCode, type CanaryResult } from "../src/index.js";

const base: CanaryResult = { liveVersion: "0.8.65", pinnedVersion: "0.8.65", sameVersion: true, evaluated: true, payloadCount: 6, allDecoded: true, compatible: true };

describe("canaryExitCode", () => {
  it("0 when compatible and current", () => {
    expect(canaryExitCode(base)).toBe(0);
  });
  it("10 when a newer version is still compatible (bump)", () => {
    expect(canaryExitCode({ ...base, liveVersion: "0.9.0", sameVersion: false })).toBe(10);
  });
  it("1 when incompatible (drift)", () => {
    expect(canaryExitCode({ ...base, compatible: false, allDecoded: false })).toBe(1);
  });
});
