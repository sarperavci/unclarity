import type { DOMWindow } from "jsdom";
import { force } from "./util.js";
import { CLOCK_ORIGIN } from "./version.js";

export interface UaBrand {
  brand: string;
  version: string;
}

// A coherent device identity. Drives BOTH the realm's navigator/screen (what clarity reads
// client-side as Dimensions) AND the transport request headers — kept consistent so the
// Clarity dashboard reports the right Browser/Device/OS. See the fidelity directive.
export interface DeviceProfile {
  readonly id: string;
  readonly userAgent: string;
  readonly platform: string;
  readonly vendor: string;
  readonly language: string;
  readonly languages: readonly string[];
  readonly hardwareConcurrency: number;
  readonly maxTouchPoints: number;
  readonly deviceMemory?: number; // Chromium only — omit for Safari/Firefox
  readonly screen: { width: number; height: number; colorDepth: number };
  readonly devicePixelRatio: number;
  readonly timezone: string;
  // Chromium client hints — omit entirely for non-Chromium engines.
  readonly uaData?: {
    brands: readonly UaBrand[];
    mobile: boolean;
    platform: string;
    platformVersion: string;
    uaFullVersion: string;
    architecture: string;
    bitness: string;
  };
}

function secChUa(brands: readonly UaBrand[]): string {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(", ");
}

// Minutes a zone is ahead of UTC (positive = ahead), computed for the FIXED virtual-clock origin
// instant — not the real wall clock — so the reported offset is deterministic (no DST drift across
// calendar dates) and coherent with the realm's pinned Date.now().
function tzOffsetMinutes(timezone: string): number {
  const ref = new Date(CLOCK_ORIGIN);
  const utc = new Date(ref.toLocaleString("en-US", { timeZone: "UTC" }));
  const local = new Date(ref.toLocaleString("en-US", { timeZone: timezone }));
  return Math.round((local.getTime() - utc.getTime()) / 60000);
}

// Identity headers our transport must send so they stay coherent with navigator.
export function profileHeaders(profile: DeviceProfile, origin: string, referer: string): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": profile.userAgent,
    accept: "*/*",
    "accept-language": `${profile.language},${profile.language.split("-")[0]};q=0.9`,
    origin,
    referer,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
  };
  if (profile.uaData) {
    headers["sec-ch-ua"] = secChUa(profile.uaData.brands);
    headers["sec-ch-ua-mobile"] = profile.uaData.mobile ? "?1" : "?0";
    headers["sec-ch-ua-platform"] = `"${profile.uaData.platform}"`;
  }
  return headers;
}

// Coherence validator — fail fast on an internally inconsistent profile (the biggest source of
// "looks synthetic" tells). Throws on the first violation.
export function validateProfile(profile: DeviceProfile): void {
  const isChromium = profile.userAgent.includes("Chrome") || profile.userAgent.includes("Chromium") || profile.userAgent.includes("Edg/");
  if (profile.uaData && !isChromium) throw new Error(`profile ${profile.id}: uaData present but UA is not Chromium`);
  if (!profile.uaData && isChromium) throw new Error(`profile ${profile.id}: Chromium UA must provide uaData`);
  if (profile.uaData && profile.uaData.mobile !== profile.maxTouchPoints > 0) {
    throw new Error(`profile ${profile.id}: uaData.mobile must match (maxTouchPoints > 0)`);
  }
  if (profile.deviceMemory !== undefined && !isChromium) {
    throw new Error(`profile ${profile.id}: deviceMemory must be omitted for non-Chromium`);
  }
  if (/Electron/i.test(profile.userAgent)) throw new Error(`profile ${profile.id}: Electron UA not allowed`);
}

// Apply the profile to a jsdom realm so clarity-js reads the intended fingerprint.
export function applyProfile(window: DOMWindow, profile: DeviceProfile): void {
  validateProfile(profile);
  const nav = window.navigator;
  force(nav, "userAgent", profile.userAgent);
  force(nav, "platform", profile.platform);
  force(nav, "vendor", profile.vendor);
  force(nav, "language", profile.language);
  force(nav, "languages", [...profile.languages]);
  force(nav, "hardwareConcurrency", profile.hardwareConcurrency);
  force(nav, "maxTouchPoints", profile.maxTouchPoints);
  force(nav, "webdriver", false);
  force(nav, "cookieEnabled", true);
  if (profile.deviceMemory !== undefined) force(nav, "deviceMemory", profile.deviceMemory);
  force(window, "devicePixelRatio", profile.devicePixelRatio);
  force(window.screen, "width", profile.screen.width);
  force(window.screen, "height", profile.screen.height);
  force(window.screen, "colorDepth", profile.screen.colorDepth);
  // Timezone coherence: clarity/analytics may read Intl + Date offset. Override both consistently.
  try {
    const offsetMin = -tzOffsetMinutes(profile.timezone);
    const RealDTF = window.Intl.DateTimeFormat;
    const patched = function (this: unknown, locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
      return new RealDTF(locale, { timeZone: profile.timezone, ...options });
    } as unknown as typeof Intl.DateTimeFormat;
    force(window.Intl, "DateTimeFormat", patched);
    force(window.Date.prototype, "getTimezoneOffset", (): number => offsetMin);
  } catch {
    /* timezone shim best-effort */
  }
  if (profile.uaData) {
    const brands = profile.uaData.brands.map((b) => ({ ...b }));
    const high = {
      platform: profile.uaData.platform,
      platformVersion: profile.uaData.platformVersion,
      uaFullVersion: profile.uaData.uaFullVersion,
      architecture: profile.uaData.architecture,
      bitness: profile.uaData.bitness,
      model: "",
      brands,
      mobile: profile.uaData.mobile,
    };
    force(nav, "userAgentData", {
      brands,
      mobile: profile.uaData.mobile,
      platform: profile.uaData.platform,
      // resolve on a microtask (Promise.resolve) so dims land in the first payload
      getHighEntropyValues: () => Promise.resolve(high),
    });
  }
}

const CHROME_VERSION = "132";
const CHROME_BRANDS: UaBrand[] = [
  { brand: "Google Chrome", version: CHROME_VERSION },
  { brand: "Chromium", version: CHROME_VERSION },
  { brand: "Not_A Brand", version: "24" },
];

const EDGE_VERSION = "132";
const EDGE_BRANDS: UaBrand[] = [
  { brand: "Microsoft Edge", version: EDGE_VERSION },
  { brand: "Chromium", version: EDGE_VERSION },
  { brand: "Not_A Brand", version: "24" },
];
const PIXEL_BRANDS: UaBrand[] = [
  { brand: "Google Chrome", version: CHROME_VERSION },
  { brand: "Chromium", version: CHROME_VERSION },
  { brand: "Not_A Brand", version: "24" },
];

export const PRESETS: Record<string, DeviceProfile> = {
  "win11-edge": {
    id: "win11-edge",
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_VERSION}.0.0.0 Safari/537.36 Edg/${EDGE_VERSION}.0.0.0`,
    platform: "Win32",
    vendor: "Google Inc.",
    language: "en-US",
    languages: ["en-US", "en"],
    hardwareConcurrency: 12,
    maxTouchPoints: 0,
    deviceMemory: 8,
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    devicePixelRatio: 1,
    timezone: "America/New_York",
    uaData: { brands: EDGE_BRANDS, mobile: false, platform: "Windows", platformVersion: "15.0.0", uaFullVersion: `${EDGE_VERSION}.0.0.0`, architecture: "x86", bitness: "64" },
  },
  "iphone15-safari": {
    id: "iphone15-safari",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    vendor: "Apple Computer, Inc.",
    language: "en-US",
    languages: ["en-US", "en"],
    hardwareConcurrency: 6,
    maxTouchPoints: 5,
    screen: { width: 393, height: 852, colorDepth: 24 },
    devicePixelRatio: 3,
    timezone: "America/Los_Angeles",
    // Safari: no userAgentData (forces navigator.platform fallback), no deviceMemory.
  },
  "pixel8-chrome": {
    id: "pixel8-chrome",
    userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Mobile Safari/537.36`,
    platform: "Linux armv8l",
    vendor: "Google Inc.",
    language: "en-US",
    languages: ["en-US", "en"],
    hardwareConcurrency: 8,
    maxTouchPoints: 5,
    deviceMemory: 8,
    screen: { width: 412, height: 915, colorDepth: 24 },
    devicePixelRatio: 2.625,
    timezone: "Europe/London",
    uaData: { brands: PIXEL_BRANDS, mobile: true, platform: "Android", platformVersion: "14.0.0", uaFullVersion: `${CHROME_VERSION}.0.0.0`, architecture: "", bitness: "" },
  },
  "win11-chrome": {
    id: "win11-chrome",
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`,
    platform: "Win32",
    vendor: "Google Inc.",
    language: "en-US",
    languages: ["en-US", "en"],
    hardwareConcurrency: 8,
    maxTouchPoints: 0,
    deviceMemory: 8,
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    devicePixelRatio: 1,
    timezone: "America/New_York",
    uaData: {
      brands: CHROME_BRANDS,
      mobile: false,
      platform: "Windows",
      platformVersion: "15.0.0",
      uaFullVersion: `${CHROME_VERSION}.0.0.0`,
      architecture: "x86",
      bitness: "64",
    },
  },
};

export function preset(id: keyof typeof PRESETS): DeviceProfile {
  const p = PRESETS[id];
  if (!p) throw new Error(`unknown device preset: ${String(id)}`);
  return p;
}
