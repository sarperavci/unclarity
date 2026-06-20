import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DOMWindow } from "jsdom";
import { request } from "undici";

const TAG_URL = (projectId: string): string => `https://www.clarity.ms/tag/${projectId}`;
const LIB_URL = (version: string): string => `https://scripts.clarity.ms/${version}/clarity.js`;
const VERSION_RE = /scripts\.clarity\.ms\/([0-9]+\.[0-9]+\.[0-9]+)\/clarity\.js/;

// Clarity's ingestion endpoint — the single place this URL lives.
export const DEFAULT_UPLOAD_URL = "https://t.clarity.ms/collect";

export class VersionFetchFailed extends Error {
  constructor(message: string, readonly body?: string) {
    super(message);
    this.name = "VersionFetchFailed";
  }
}

export interface TagConfig {
  version: string;
  upload: string;
  cookies: string[];
  dob: number | undefined;
}

// Pure parser for a tag bootstrap body. Tolerates quoted/single-quoted/unquoted keys across tag
// shapes (JSON-object config or inlined IIFE args). Returns null version if it can't be found.
export function parseTagBody(body: string): { version: string | null } & Omit<TagConfig, "version"> {
  const version = VERSION_RE.exec(body)?.[1] ?? null;
  const upload = /["']?upload["']?\s*:\s*["']([^"']+)["']/.exec(body)?.[1] ?? DEFAULT_UPLOAD_URL;
  const dobRaw = /["']?dob["']?\s*:\s*([0-9]+)/.exec(body)?.[1];
  const cookiesRaw = /["']?cookies["']?\s*:\s*\[([^\]]*)\]/.exec(body)?.[1] ?? "";
  const cookies = cookiesRaw
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return { version, upload, cookies, dob: dobRaw ? Number(dobRaw) : undefined };
}

// Parse the live tag bootstrap so synthetic sessions mirror the project's real config (upload
// endpoint, cookie list, dob sampling) instead of guessed defaults. Fidelity directive.
export async function parseTagConfig(projectId: string): Promise<TagConfig> {
  const res = await request(TAG_URL(projectId));
  const body = await res.body.text();
  if (res.statusCode !== 200) throw new VersionFetchFailed(`tag fetch for ${projectId} returned ${res.statusCode}`, body);
  const parsed = parseTagBody(body);
  if (!parsed.version) throw new VersionFetchFailed(`could not parse clarity version from tag for ${projectId}`, body);
  return { ...parsed, version: parsed.version };
}

export type ProviderSource = "pinned" | "live" | "fork";

export interface ClarityBundleProvider {
  resolveVersion(projectId: string): Promise<string>;
  fetchLibrary(version: string): Promise<string>;
  evaluate(window: DOMWindow, source: string): void;
  describe(): { source: ProviderSource; version: string };
}

const CACHE_DIR = join(tmpdir(), "unclarity-cache");

// Reject a truncated/empty/corrupt cached library. The real bundle is ~70KB+ and self-identifies in a
// header comment; a partial write (killed mid-fetch) or 0-byte file must NOT be served as valid.
export function isValidLibrary(src: string): boolean {
  return src.length > 10_000 && src.includes("clarity");
}

async function fetchLibrary(version: string): Promise<string> {
  const cached = join(CACHE_DIR, `clarity-${version}.js`);
  if (existsSync(cached)) {
    const existing = await readFile(cached, "utf8");
    if (isValidLibrary(existing)) return existing;
    // poisoned cache (partial/empty) — fall through and re-fetch
  }
  const res = await request(LIB_URL(version));
  if (res.statusCode !== 200) throw new VersionFetchFailed(`clarity.js ${version} fetch returned ${res.statusCode}`);
  const src = await res.body.text();
  if (!isValidLibrary(src)) throw new VersionFetchFailed(`fetched clarity.js ${version} failed validation (len=${src.length})`);
  await mkdir(CACHE_DIR, { recursive: true });
  // Atomic write: stage to a unique temp file then rename, so a crash never leaves a partial cache.
  const tmp = `${cached}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, src);
  await rename(tmp, cached);
  return src;
}

// Shared provider behavior: evaluate the library into the realm (build the command queue ourselves —
// do NOT replay the real 707-byte bootstrap whose dup-guard/c.gif logic we manage separately — then
// inject the library so queue.process() drains it) and fetch from the cached CDN. One realm = one
// clarity instance. Subclasses differ only in how the version is resolved + how they describe()
// themselves.
abstract class BaseProvider implements ClarityBundleProvider {
  abstract resolveVersion(projectId: string): Promise<string>;
  abstract describe(): { source: ProviderSource; version: string };
  fetchLibrary(version: string): Promise<string> {
    return fetchLibrary(version);
  }
  evaluate(window: DOMWindow, source: string): void {
    const script = window.document.createElement("script");
    script.textContent = source;
    window.document.body.appendChild(script);
  }
}

// DEFAULT: reproducible — a pinned version's bytes never change mid-run.
export class PinnedCdn extends BaseProvider {
  constructor(private readonly version: string) {
    super();
  }
  resolveVersion(): Promise<string> {
    return Promise.resolve(this.version);
  }
  describe(): { source: "pinned"; version: string } {
    return { source: "pinned", version: this.version };
  }
}

// Opt-in: bleeding edge. Detects the version Microsoft currently serves. Never silently falls back.
export class LiveCdn extends BaseProvider {
  private detected: string | undefined;
  async resolveVersion(projectId: string): Promise<string> {
    const { version } = await parseTagConfig(projectId); // reuse the one tag-fetch+parse contract
    this.detected = version;
    return version;
  }
  describe(): { source: "live"; version: string } {
    return { source: "live", version: this.detected ?? "unresolved" };
  }
}

// Last resort / offline: run a locally-provided clarity.js file (e.g. a self-built fork output),
// byte-for-byte reproducible with no network. The caller owns the version label it represents.
export class LocalFork extends BaseProvider {
  constructor(
    private readonly filePath: string,
    private readonly version = "fork",
  ) {
    super();
  }
  resolveVersion(): Promise<string> {
    return Promise.resolve(this.version);
  }
  override async fetchLibrary(): Promise<string> {
    const src = await readFile(this.filePath, "utf8");
    if (!isValidLibrary(src)) throw new VersionFetchFailed(`local clarity.js at ${this.filePath} failed validation (len=${src.length})`);
    return src;
  }
  describe(): { source: "fork"; version: string } {
    return { source: "fork", version: this.version };
  }
}
