import { decode } from "clarity-decode";
import { createSession } from "./dom-host.js";
import { PinnedCdn, LiveCdn } from "./clarity-provider.js";
import { preset } from "./device-profile.js";
import { scenario } from "./scenario.js";
import { runScenario } from "./runner.js";
import { Rng } from "./prng.js";
import { DEFAULT_CLARITY_VERSION } from "./version.js";

export interface CanaryResult {
  liveVersion: string;
  pinnedVersion: string;
  sameVersion: boolean;
  evaluated: boolean;
  payloadCount: number;
  allDecoded: boolean;
  compatible: boolean;
  error?: string;
}

const CANARY_HTML = `<!DOCTYPE html><html><head><title>canary</title><style>#a{padding:8px}</style></head>
<body><h1 id="t">Canary</h1><button id="a">Go</button><input id="s"></body></html>`;

// Contract test against the LIVE clarity.js Microsoft currently serves: load it in a deterministic
// (hermetic, no-network) session, drive a few interactions, and assert every payload decodes with the
// real clarity-decode. This is the compatibility signal the CI canary acts on.
export async function runCanary(projectId: string, pinnedVersion = DEFAULT_CLARITY_VERSION): Promise<CanaryResult> {
  const liveVersion = await new LiveCdn().resolveVersion(projectId);
  const base = { liveVersion, pinnedVersion, sameVersion: liveVersion === pinnedVersion };
  try {
    const session = await createSession({
      projectId,
      html: CANARY_HTML,
      url: "https://example.com/",
      profile: preset("win11-chrome"),
      provider: new PinnedCdn(liveVersion),
      seed: 1,
      deterministic: true,
    });
    const sc = scenario().scrollTo(200).click("#a").type("#s", "hi").build();
    await runScenario(session, sc, new Rng(1));
    await session.end();
    session.close();
    const payloads = session.payloads;
    const decodes = (p: string): boolean => {
      try {
        decode(p);
        return true;
      } catch {
        return false;
      }
    };
    const allDecoded = payloads.length > 0 && payloads.every(decodes);
    return { ...base, evaluated: true, payloadCount: payloads.length, allDecoded, compatible: allDecoded };
  } catch (err) {
    return { ...base, evaluated: false, payloadCount: 0, allDecoded: false, compatible: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Exit codes drive the CI workflow: 0 = compatible & current, 10 = newer version still compatible
// (bump PR), 1 = incompatible (drift → issue + alert).
export function canaryExitCode(r: CanaryResult): 0 | 1 | 10 {
  if (!r.compatible) return 1;
  return r.sameVersion ? 0 : 10;
}
