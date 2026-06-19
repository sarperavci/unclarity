import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DOMWindow } from "jsdom";
import { request } from "undici";

const TAG_URL = (projectId: string): string => `https://www.clarity.ms/tag/${projectId}`;
const LIB_URL = (version: string): string => `https://scripts.clarity.ms/${version}/clarity.js`;
const VERSION_RE = /scripts\.clarity\.ms\/([0-9]+\.[0-9]+\.[0-9]+)\/clarity\.js/;

export class VersionFetchFailed extends Error {
  constructor(message: string, readonly body?: string) {
    super(message);
    this.name = "VersionFetchFailed";
  }
}

export interface ClarityBundleProvider {
  resolveVersion(projectId: string): Promise<string>;
  fetchLibrary(version: string): Promise<string>;
  evaluate(window: DOMWindow, source: string): void;
  describe(): { source: "pinned" | "live" | "fork"; version: string };
}

const CACHE_DIR = join(tmpdir(), "unclarity-cache");

async function fetchLibrary(version: string): Promise<string> {
  const cached = join(CACHE_DIR, `clarity-${version}.js`);
  if (existsSync(cached)) return readFile(cached, "utf8");
  const res = await request(LIB_URL(version));
  if (res.statusCode !== 200) throw new VersionFetchFailed(`clarity.js ${version} fetch returned ${res.statusCode}`);
  const src = await res.body.text();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cached, src);
  return src;
}

// Evaluate the library into the realm. We build the command queue ourselves (do NOT replay the real
// 707-byte bootstrap, whose dup-guard/c.gif logic we manage separately), then inject the library so
// queue.process() drains it. One realm = one clarity instance.
function evaluate(window: DOMWindow, source: string): void {
  const script = window.document.createElement("script");
  script.textContent = source;
  window.document.body.appendChild(script);
}

// DEFAULT: reproducible — a pinned version's bytes never change mid-run.
export class PinnedCdn implements ClarityBundleProvider {
  constructor(private readonly version: string) {}
  resolveVersion(): Promise<string> {
    return Promise.resolve(this.version);
  }
  fetchLibrary(version: string): Promise<string> {
    return fetchLibrary(version);
  }
  evaluate = evaluate;
  describe(): { source: "pinned"; version: string } {
    return { source: "pinned", version: this.version };
  }
}

// Opt-in: bleeding edge. Detects the version Microsoft currently serves. Never silently falls back.
export class LiveCdn implements ClarityBundleProvider {
  private detected: string | undefined;
  async resolveVersion(projectId: string): Promise<string> {
    const res = await request(TAG_URL(projectId));
    const body = await res.body.text();
    if (res.statusCode !== 200) throw new VersionFetchFailed(`tag fetch for ${projectId} returned ${res.statusCode}`, body);
    const m = VERSION_RE.exec(body);
    if (!m?.[1]) throw new VersionFetchFailed(`could not parse clarity version from tag for ${projectId}`, body);
    this.detected = m[1];
    return m[1];
  }
  fetchLibrary(version: string): Promise<string> {
    return fetchLibrary(version);
  }
  evaluate = evaluate;
  describe(): { source: "live"; version: string } {
    return { source: "live", version: this.detected ?? "unresolved" };
  }
}
