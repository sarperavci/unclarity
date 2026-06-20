import { chromium, type Browser, type BrowserContext } from "playwright";
import { writeBundle, PRESETS, type BundleManifest, type GeometryMap } from "@unclarity/core";

export interface CaptureStep {
  action: "click" | "fill" | "wait" | "goto";
  selector?: string;
  text?: string;
  ms?: number;
  url?: string;
}

export interface CaptureOptions {
  url: string;
  outDir: string;
  // Auth: a Playwright storageState file (cookies + localStorage) to reach gated pages.
  storageState?: string;
  viewport?: { width: number; height: number };
  userAgent?: string;
  // Scripted pre-snapshot interactions (login, navigate, expand content) before the snapshot.
  steps?: CaptureStep[];
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  // Capture as a known device preset (sets viewport, UA, DPR, mobile/touch coherently).
  device?: keyof typeof PRESETS;
}

interface RawCapture {
  html: string;
  geometry: GeometryMap;
  viewport: { width: number; height: number };
  docHeight: number;
  dpr: number;
}

// Runs in the browser: stamp data-uc-id, inline stylesheets, collect per-node geometry, serialize.
/* c8 ignore start */
function snapshot(): RawCapture {
  let counter = 1;
  const geometry: Record<string, { x: number; y: number; width: number; height: number }> = {};
  const all = document.documentElement.querySelectorAll("*");
  const els: Element[] = [document.documentElement, ...Array.from(all)];
  const sx = window.scrollX;
  const sy = window.scrollY;
  for (const el of els) {
    const id = String(counter++);
    el.setAttribute("data-uc-id", id);
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      geometry[id] = { x: Math.round(r.left + sx), y: Math.round(r.top + sy), width: Math.round(r.width), height: Math.round(r.height) };
    }
  }
  // Inline external stylesheets into <style> (verbatim cssText) so jsdom replay needs no network.
  for (const sheet of Array.from(document.styleSheets)) {
    const owner = sheet.ownerNode as Element | null;
    if (!owner || owner.tagName !== "LINK") continue;
    try {
      let css = "";
      for (const rule of Array.from(sheet.cssRules)) css += rule.cssText;
      const style = document.createElement("style");
      style.textContent = css;
      style.setAttribute("data-uc-id", String(counter++));
      owner.replaceWith(style);
    } catch {
      /* cross-origin sheet: cssRules not readable, leave the <link> */
    }
  }
  return {
    html: `<!DOCTYPE html>${document.documentElement.outerHTML}`,
    geometry,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    docHeight: document.documentElement.scrollHeight,
    dpr: window.devicePixelRatio,
  };
}
/* c8 ignore stop */

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_WAIT_MS = 500;

export async function capture(opts: CaptureOptions): Promise<BundleManifest> {
  const dev = opts.device ? PRESETS[opts.device] : undefined;
  const mobile = dev ? dev.maxTouchPoints > 0 : false;
  const viewport = opts.viewport ?? (dev ? { width: dev.screen.width, height: dev.screen.height } : DEFAULT_VIEWPORT);
  const userAgent = opts.userAgent ?? dev?.userAgent;
  const waitUntil = opts.waitUntil ?? "networkidle";
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const context: BrowserContext = await browser.newContext({
      viewport,
      ...(userAgent ? { userAgent } : {}),
      ...(dev ? { deviceScaleFactor: dev.devicePixelRatio, isMobile: mobile, hasTouch: mobile } : {}),
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil });
    for (const step of opts.steps ?? []) {
      switch (step.action) {
        case "click":
          if (step.selector) await page.click(step.selector);
          break;
        case "fill":
          if (step.selector) await page.fill(step.selector, step.text ?? "");
          break;
        case "goto":
          if (step.url) await page.goto(step.url, { waitUntil });
          break;
        case "wait":
          await page.waitForTimeout(step.ms ?? DEFAULT_WAIT_MS);
          break;
        default:
          throw new Error(`unclarity capture: unknown step action ${String((step as { action: string }).action)}`);
      }
    }
    const raw = (await page.evaluate(snapshot)) as RawCapture;
    const manifest: BundleManifest = {
      sourceUrl: opts.url,
      viewport: raw.viewport,
      dpr: raw.dpr,
      docHeight: raw.docHeight,
      geometryMode: "captured",
      capturedAt: new Date().toISOString(),
    };
    await writeBundle(opts.outDir, raw.html, manifest, raw.geometry);
    return manifest;
  } finally {
    await browser.close();
  }
}
