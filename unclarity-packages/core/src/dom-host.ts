import { JSDOM, VirtualConsole } from "jsdom";
import type { Dispatcher } from "undici";
import type { DeviceProfile } from "./device-profile.js";
import { applyProfile, profileHeaders } from "./device-profile.js";
import { installShims, assertReady, setScroll } from "./shims.js";
import { installGeometryOracle, type GeometryMap } from "./geometry.js";
import type { LoadedBundle } from "./bundle.js";
import { installTransport, type UploadRecord } from "./transport.js";
import type { ClarityBundleProvider } from "./clarity-provider.js";
import { force, sleep } from "./util.js";

const COLLECT = "https://t.clarity.ms/collect";

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
}

export interface Session {
  readonly clarityVersion: string;
  readonly bundleSource: "pinned" | "live" | "fork";
  readonly uploadLog: UploadRecord[];
  move(selector: string): void;
  click(selector: string): void;
  scrollTo(y: number): void;
  type(selector: string, text: string): void;
  /** Dispatch pagehide (final flush) and wait for all uploads to settle. */
  end(): Promise<void>;
  /** Release the realm. */
  close(): void;
}

export async function createSession(opts: SessionOptions): Promise<Session> {
  const html = opts.html ?? opts.bundle?.html;
  if (html === undefined) throw new Error("unclarity: createSession requires `html` or `bundle`");
  const version = await opts.provider.resolveVersion(opts.projectId);
  const source = await opts.provider.fetchLibrary(version);
  const viewport = opts.viewport ?? opts.bundle?.manifest.viewport ?? { width: 1280, height: 800 };
  const docHeight = opts.docHeight ?? opts.bundle?.manifest.docHeight ?? 3000;
  const geometry = opts.geometry ?? opts.bundle?.geometry;
  const origin = new URL(opts.url).origin;

  const vc = new VirtualConsole();
  const dom = new JSDOM(html, { url: opts.url, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;

  installShims(window);
  applyProfile(window, opts.profile);
  installGeometryOracle(window, { viewport, docHeight, ...(geometry ? { byId: geometry } : {}) });
  const transport = installTransport(window, {
    headers: profileHeaders(opts.profile, origin, opts.url),
    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
  });

  assertReady(window);

  const startConfig: Record<string, unknown> = {
    projectId: opts.projectId,
    upload: opts.upload ?? COLLECT,
    delay: 200,
    lean: false,
    content: true,
    track: true,
    ...opts.clarityConfig,
  };

  type ClarityFn = { (...args: unknown[]): void; q?: unknown[][]; v?: string };
  const clarity: ClarityFn = function (this: unknown, ...args: unknown[]): void {
    (clarity.q ??= []).push(args);
  };
  force(window, "clarity", clarity);
  clarity("start", startConfig);

  opts.provider.evaluate(window, source);
  await sleep(300); // allow discover + initial scheduled tasks to run

  const stamp = <T extends Event>(ev: T): T => {
    // jsdom stamps synthetic events with an absolute epoch timeStamp; clarity's time() expects it
    // relative to performance.timeOrigin. Normalize to a relative high-res value.
    Object.defineProperty(ev, "timeStamp", { value: window.performance.now(), configurable: true });
    return ev;
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
  const fire = (el: EventTarget, ev: Event): boolean => el.dispatchEvent(stamp(ev));
  const view = window as unknown as Window;
  const mouse = (type: string, el: Element, x: number, y: number): void => {
    fire(el, new window.MouseEvent(type, { bubbles: true, cancelable: true, view, button: 0, detail: 1, clientX: x, clientY: y }));
  };

  const describe = opts.provider.describe();

  return {
    clarityVersion: version,
    bundleSource: describe.source,
    uploadLog: transport.log,
    move(selector) {
      const el = require(selector);
      const { x, y } = center(el);
      mouse("mousemove", el, x, y);
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
      // Let scheduled encodes + the batched upload timer (config.delay) run BEFORE the final flush,
      // otherwise stop() flushes before late events (e.g. clicks) are encoded.
      await sleep(400);
      fire(window, new window.Event("pagehide"));
      await sleep(300);
      await transport.settled();
    },
    close() {
      window.close();
    },
  };
}
