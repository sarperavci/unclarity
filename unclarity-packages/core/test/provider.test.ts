import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTagBody, isValidLibrary, LocalFork, VersionFetchFailed } from "../src/index.js";

describe("parseTagBody", () => {
  it("parses the real double-quoted JSON tag shape", () => {
    const body = `t.src="https://scripts.clarity.ms/0.8.65/clarity.js";clarity("start",{"projectId":"x9kvmle61a","upload":"https://t.clarity.ms/collect","expire":365,"cookies":["_uetmsclkid","_uetvid","_clck"],"track":true,"content":true,"dob":2361});`;
    const c = parseTagBody(body);
    expect(c.version).toBe("0.8.65");
    expect(c.upload).toBe("https://t.clarity.ms/collect");
    expect(c.dob).toBe(2361);
    expect(c.cookies).toEqual(["_uetmsclkid", "_uetvid", "_clck"]);
  });

  it("tolerates unquoted/single-quoted keys (IIFE-arg shape)", () => {
    const body = `https://scripts.clarity.ms/1.2.3/clarity.js ... {projectId:'p',upload:'https://x.test/c',cookies:['_clck'],dob:42}`;
    const c = parseTagBody(body);
    expect(c.version).toBe("1.2.3");
    expect(c.upload).toBe("https://x.test/c");
    expect(c.dob).toBe(42);
    expect(c.cookies).toEqual(["_clck"]);
  });

  it("returns null version + safe defaults when nothing matches", () => {
    const c = parseTagBody("not a tag");
    expect(c.version).toBeNull();
    expect(c.upload).toBe("https://t.clarity.ms/collect");
    expect(c.cookies).toEqual([]);
    expect(c.dob).toBeUndefined();
  });
});

describe("isValidLibrary (cache-poisoning guard)", () => {
  it("rejects empty / truncated files", () => {
    expect(isValidLibrary("")).toBe(false);
    expect(isValidLibrary("clarity")).toBe(false); // too short
    expect(isValidLibrary("x".repeat(20000))).toBe(false); // big but no marker
  });
  it("accepts a plausible full library", () => {
    expect(isValidLibrary(`/* clarity-js v0.8.65 */ ${"a".repeat(20000)} clarity`)).toBe(true);
  });
});

describe("LocalFork provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-fork-"));

  it("loads a valid local library and describes itself as fork", async () => {
    const file = join(dir, "good.js");
    writeFileSync(file, `/* clarity */ ${"a".repeat(20000)}`);
    const p = new LocalFork(file, "0.8.65-local");
    expect(await p.resolveVersion()).toBe("0.8.65-local");
    expect((await p.fetchLibrary()).length).toBeGreaterThan(10000);
    expect(p.describe()).toEqual({ source: "fork", version: "0.8.65-local" });
  });

  it("rejects a truncated local library", async () => {
    const file = join(dir, "bad.js");
    writeFileSync(file, "clarity");
    await expect(new LocalFork(file).fetchLibrary()).rejects.toBeInstanceOf(VersionFetchFailed);
  });
});
