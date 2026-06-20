import { JSDOM, VirtualConsole } from "jsdom";
import type { DOMWindow } from "jsdom";
import type { Dispatcher } from "undici";
import type { DeviceProfile } from "./device-profile.js";
import { applyProfile, profileHeaders } from "./device-profile.js";
import { installShims, assertReady, setScroll } from "./shims.js";
import { installGeometryOracle, type GeometryMap } from "./geometry.js";
import { Rng } from "./prng.js";
import { VirtualClock } from "./virtual-clock.js";
import type { LoadedBundle } from "./bundle.js";
import { installTransport, type UploadRecord } from "./transport.js";
import { DEFAULT_UPLOAD_URL, type ClarityBundleProvider, type ProviderSource } from "./clarity-provider.js";
import { force, sleep } from "./util.js";

const COLLECT = DEFAULT_UPLOAD_URL;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_DOC_HEIGHT = 3000;
// Upload-batching delay (clarity config.delay). Deterministic mode uses a shorter virtual delay so
// fewer virtual-clock ticks are needed to flush; real mode keeps clarity's default-ish cadence.
const UPLOAD_DELAY_REAL_MS = 200;
const UPLOAD_DELAY_VIRTUAL_MS = 50;
const DISCOVER_SETTLE_MS = 300; // let discover + first scheduled upload run after eval
const FLUSH_BEFORE_PAGEHIDE_MS = 400; // let late encodes + the batch timer fire before final flush
const FLUSH_AFTER_PAGEHIDE_MS = 300; // let the final beacon upload complete

type ClarityFn = { (...args: unknown[]): void; q?: unknown[][]; v?: string };

// Set up the clarity command-queue stub on the realm; the library drains it once evaluated.
function installClarityQueue(window: DOMWindow): ClarityFn {
  const clarity: ClarityFn = function (this: unknown, ...args: unknown[]): void {
    (clarity.q ??= []).push(args);
  };
  force(window, "clarity", clarity);
  return clarity;
}

export interface SessionOptions {
  projectId: string;
  url: string;
  profile: DeviceProfile;
  provider: ClarityBundleProvider;
  // Page source: either raw HTML, or a loaded Bundle (manifest + geometry). One is required.
  html?: string;
  bundle?: LoadedBundle;
  // Where clarity uploads. A string URL exercises the real XHR/gzip transport (default: real
  // ingestion). A callback receives the raw encoded payload (the no-forge seam, used for offline tests).
  upload?: string | ((payload: string) => void);
  viewport?: { width: number; height: number };
  docHeight?: number;
  geometry?: GeometryMap;
  dispatcher?: Dispatcher;
  clarityConfig?: Record<string, unknown>;
  // When set, crypto.getRandomValues is seeded so userId/sessionId are reproducible for this seed.
  seed?: number;
  // Full determinism: virtual clock + seeded randomness + uncompressed callback upload, so the same
  // seed yields byte-identical payloads (see `payloads`). Requires `seed`. Implies no real network.
  deterministic?: boolean;
}

export interface Session {
  readonly clarityVersion: string;
  readonly bundleSource: "pinned" | "live" | "fork";
  readonly uploadLog: UploadRecord[];
  /** Raw encoded payload strings captured in deterministic/callback mode (empty in URL mode). */
  readonly payloads: string[];
  /** Advance time: virtual clock in deterministic mode, real sleep otherwise. */
  advance(ms: number): Promise<void>;
  move(selector: string): void;
  /** Dispatch a mousemove at raw viewport coordinates (used to play realism paths). */
  moveTo(x: number, y: number): void;
  /** Viewport-coordinate box of an element (from the geometry oracle). */
  locate(selector: string): { x: number; y: number; width: number; height: number };
  click(selector: string): void;
  scrollTo(y: number): void;
  type(selector: string, text: string): void;
  /** Dispatch pagehide (final flush) and wait for all uploads to settle. */
  end(): Promise<void>;
  /** Release the realm. */
  close(): void;
}

// Seeded identity: deterministic getRandomValues → reproducible userId/sessionId for a seed.
// crypto.subtle (identify SHA-256) stays real.
function installSeededCrypto(window: DOMWindow, seed: number): void {
  const idRng = new Rng((seed ^ 0x53c0ffee) >>> 0);
  const subtle = window.crypto.subtle;
  force(window, "crypto", {
    subtle,
    randomUUID: () => `${idRng.int(0, 0xffffffff).toString(16)}-seeded`,
    getRandomValues: <T extends ArrayBufferView | null>(arr: T): T => {
      if (arr) {
        const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        for (let i = 0; i < view.length; i++) view[i] = idRng.int(0, 255);
      }
      return arr;
    },
  });
}

interface SessionContext {
  window: DOMWindow;
  version: string;
  bundleSource: ProviderSource;
  transport: ReturnType<typeof installTransport>;
  payloads: string[];
  tick: (ms: number) => Promise<void>;
  clock: VirtualClock | undefined;
}

// Build the behavioral Session API (the input-dispatch methods) over a fully-set-up realm.
function buildSessionApi(ctx: SessionContext): Session {
  const { window, transport, payloads, tick, clock } = ctx;
  const view = window as unknown as Window;

  // jsdom stamps synthetic events with an absolute epoch timeStamp; clarity's time() expects it
  // relative to performance.timeOrigin. Normalize to a relative high-res value.
  const stamp = <T extends Event>(ev: T): T => {
    Object.defineProperty(ev, "timeStamp", { value: window.performance.now(), configurable: true });
    return ev;
  };
  const fire = (el: EventTarget, ev: Event): boolean => el.dispatchEvent(stamp(ev));
  const mouse = (type: string, el: Element, x: number, y: number): void => {
    fire(el, new window.MouseEvent(type, { bubbles: true, cancelable: true, view, button: 0, detail: 1, clientX: x, clientY: y }));
  };
  const require = (selector: string): Element => {
    const el = window.document.querySelector(selector);
    if (!el) throw new Error(`unclarity: selector not found: ${selector}`);
    return el;
  };
  const center = (el: Element): { x: number; y: number } => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };

  return {
    clarityVersion: ctx.version,
    bundleSource: ctx.bundleSource,
    uploadLog: transport.log,
    payloads,
    advance: tick,
    move(selector) {
      const el = require(selector);
      const { x, y } = center(el);
      mouse("mousemove", el, x, y);
    },
    moveTo(x, y) {
      const el = window.document.elementFromPoint(x, y) ?? window.document.body;
      mouse("mousemove", el, x, y);
    },
    locate(selector) {
      const r = require(selector).getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
    click(selector) {
      const el = require(selector);
      const { x, y } = center(el);
      mouse("mousemove", el, x, y);
      mouse("mousedown", el, x, y);
      mouse("mouseup", el, x, y);
      mouse("click", el, x, y);
    },
    scrollTo(y) {
      setScroll(window, y);
      fire(window, new window.Event("scroll"));
    },
    type(selector, text) {
      const el = require(selector) as HTMLInputElement;
      const c = center(el);
      mouse("click", el, c.x, c.y);
      el.value = text;
      fire(el, new window.Event("input", { bubbles: true }));
    },
    async end() {
      // Let scheduled encodes + the batched upload timer run BEFORE the final flush, else stop()
      // flushes before late events (e.g. clicks) are encoded.
      await tick(FLUSH_BEFORE_PAGEHIDE_MS);
      fire(window, new window.Event("pagehide"));
      await tick(FLUSH_AFTER_PAGEHIDE_MS);
      await transport.settled();
    },
    close() {
      clock?.uninstall(window); // H1: restore the shared Math.random override
      window.close();
    },
  };
}

export async function createSession(opts: SessionOptions): Promise<Session> {
  const html = opts.html ?? opts.bundle?.html;
  if (html === undefined) throw new Error("unclarity: createSession requires `html` or `bundle`");
  if (opts.deterministic && opts.seed === undefined) throw new Error("unclarity: deterministic mode requires a seed");

  const version = await opts.provider.resolveVersion(opts.projectId);
  const source = await opts.provider.fetchLibrary(version);
  const viewport = opts.viewport ?? opts.bundle?.manifest.viewport ?? DEFAULT_VIEWPORT;
  const docHeight = opts.docHeight ?? opts.bundle?.manifest.docHeight ?? DEFAULT_DOC_HEIGHT;
  const geometry = opts.geometry ?? opts.bundle?.geometry;
  const origin = new URL(opts.url).origin;

  const dom = new JSDOM(html, { url: opts.url, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const { window } = dom;

  // H8: if anything during setup/eval throws, close the realm before rethrowing (runOne's finally
  // only covers an already-resolved session).
  try {
    installShims(window);
    applyProfile(window, opts.profile);
    installGeometryOracle(window, { viewport, docHeight, ...(geometry ? { byId: geometry } : {}) });

    // Deterministic mode: virtual clock + no async compression (CompressionStream removed so
    // compress() short-circuits synchronously) so payloads are reproducible and free of real async.
    const clock = opts.deterministic ? new VirtualClock(opts.seed ?? 0) : undefined;
    if (clock) {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, "CompressionStream");
      clock.install(window);
    }
    if (opts.seed !== undefined) installSeededCrypto(window, opts.seed);

    const transport = installTransport(window, {
      headers: profileHeaders(opts.profile, origin, opts.url),
      ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
    });
    assertReady(window);

    // Deterministic mode captures payloads via a callback (no real network); else default to ingestion.
    const payloads: string[] = [];
    const upload = clock ? (p: string) => void payloads.push(p) : (opts.upload ?? COLLECT);
    const tick = clock ? (ms: number) => clock.advance(ms) : (ms: number) => sleep(ms);

    const clarity = installClarityQueue(window);
    clarity("start", {
      projectId: opts.projectId,
      upload,
      delay: clock ? UPLOAD_DELAY_VIRTUAL_MS : UPLOAD_DELAY_REAL_MS,
      lean: false,
      content: true,
      track: true,
      ...opts.clarityConfig,
    });
    opts.provider.evaluate(window, source);
    await tick(DISCOVER_SETTLE_MS); // allow discover + initial scheduled tasks (+ first upload) to run

    return buildSessionApi({ window, version, bundleSource: opts.provider.describe().source, transport, payloads, tick, clock });
  } catch (err) {
    window.close();
    throw err;
  }
}
