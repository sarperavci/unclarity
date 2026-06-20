import { ProxyAgent, type Dispatcher } from "undici";
import { socksDispatcher } from "./socks.js";
import { createSession } from "./dom-host.js";
import { loadBundle } from "./bundle.js";
import { preset } from "./device-profile.js";
import { PinnedCdn, LiveCdn, type ClarityBundleProvider } from "./clarity-provider.js";
import { runScenario } from "./runner.js";
import { Rng } from "./prng.js";
import type { Scenario } from "./scenario.js";

const DEFAULT_VERSION = "0.8.65";

export interface ProxyConfig {
  url: string;
  pool?: string[];
  rotate?: "per-session" | "per-run" | "sticky";
}

export interface RunRequest {
  projectId: string;
  url: string;
  bundleDir?: string;
  html?: string;
  profile: string; // preset id (serializable)
  scenario: Scenario;
  count: number;
  concurrency: number;
  seed: number;
  clarity?: { source?: "pinned" | "live"; version?: string };
  upload?: string; // override (e.g. local collector for tests)
  network?: { proxy?: ProxyConfig };
  deterministic?: boolean; // virtual clock + seeded randomness → reproducible payloads
}

export type Verdict = "ok" | "degraded" | "failed";

export interface SessionResult {
  index: number;
  clarityVersion: string;
  bundleSource: "pinned" | "live" | "fork";
  verdict: Verdict;
  uploads: number;
  ok: number;
  durationMs: number;
  egress?: string;
  error?: string;
}

function makeProvider(req: RunRequest): ClarityBundleProvider {
  const source = req.clarity?.source ?? "pinned";
  if (source === "live") return new LiveCdn();
  return new PinnedCdn(req.clarity?.version ?? DEFAULT_VERSION);
}

function dispatcherFor(index: number, proxy: ProxyConfig | undefined): { dispatcher?: Dispatcher; egress?: string } {
  if (!proxy) return {};
  const pool = proxy.pool && proxy.pool.length > 0 ? proxy.pool : [proxy.url];
  const url = proxy.rotate === "per-session" ? pool[index % pool.length]! : pool[0]!;
  const egress = url.replace(/:\/\/[^@]*@/, "://***@");
  const dispatcher = url.startsWith("socks") ? socksDispatcher(url) : new ProxyAgent(url);
  return { dispatcher, egress };
}

async function runOne(req: RunRequest, index: number, provider: ClarityBundleProvider): Promise<SessionResult> {
  const start = performance.now();
  const sessionSeed = (req.seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  const rng = new Rng(sessionSeed);
  const { dispatcher, egress } = dispatcherFor(index, req.network?.proxy);
  const profileObj = preset(req.profile);
  const bundle = req.bundleDir ? await loadBundle(req.bundleDir) : undefined;
  const geometryMode: string | undefined = bundle?.manifest.geometryMode;

  const session = await createSession({
    projectId: req.projectId,
    url: req.url,
    profile: profileObj,
    provider,
    seed: sessionSeed,
    ...(req.deterministic ? { deterministic: true } : {}),
    ...(bundle ? { bundle } : {}),
    ...(req.html ? { html: req.html } : {}),
    ...(req.upload ? { upload: req.upload } : {}),
    ...(dispatcher ? { dispatcher } : {}),
  });
  try {
    await runScenario(session, req.scenario, rng);
    await session.end();
    // Deterministic/callback mode reports via captured payloads; URL mode via the HTTP log.
    const uploads = req.deterministic ? session.payloads.length : session.uploadLog.length;
    const ok = req.deterministic ? uploads : session.uploadLog.filter((r) => r.status >= 200 && r.status <= 208).length;
    let verdict: Verdict = ok === uploads && uploads > 0 ? "ok" : "failed";
    if (verdict === "ok" && geometryMode === "inferred") verdict = "degraded";
    return {
      index,
      clarityVersion: session.clarityVersion,
      bundleSource: session.bundleSource,
      verdict,
      uploads,
      ok,
      durationMs: Math.round(performance.now() - start),
      ...(egress ? { egress } : {}),
    };
  } catch (err) {
    return {
      index,
      clarityVersion: session.clarityVersion,
      bundleSource: session.bundleSource,
      verdict: "failed",
      uploads: session.uploadLog.length,
      ok: 0,
      durationMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    session.close();
  }
}

// Run `count` sessions with a bounded concurrency pool, yielding each result as it completes.
export async function* run(req: RunRequest): AsyncGenerator<SessionResult> {
  const provider = makeProvider(req);
  const concurrency = Math.max(1, Math.min(req.concurrency || 1, 16));
  let next = 0;
  const active = new Map<number, Promise<SessionResult>>();

  const launch = (): void => {
    const i = next++;
    active.set(
      i,
      runOne(req, i, provider).catch(
        (err): SessionResult => ({ index: i, clarityVersion: "", bundleSource: provider.describe().source, verdict: "failed", uploads: 0, ok: 0, durationMs: 0, error: err instanceof Error ? err.message : String(err) }),
      ),
    );
  };

  while (next < req.count && active.size < concurrency) launch();
  while (active.size > 0) {
    const done = await Promise.race(active.values());
    active.delete(done.index);
    yield done;
    if (next < req.count) launch();
  }
}
