import type { DOMWindow } from "jsdom";
import { force } from "./util.js";

// Globals clarity.js captures at MODULE-EVAL time (compress.ts, task.ts). They MUST exist on the
// realm window before the library is evaluated, else capture silently degrades.
const REQUIRED_GLOBALS = ["MutationObserver", "CompressionStream", "crypto", "requestIdleCallback", "performance"] as const;

// Install the minimum environment for Microsoft's clarity.js to run in a jsdom realm.
// Order matters: call this BEFORE evaluating the library bundle.
export function installShims(window: DOMWindow): void {
  // performance: jsdom provides now(); clarity's core/time.ts reads view.performance.timeOrigin.
  if (typeof window.performance.timeOrigin !== "number") {
    force(window.performance, "timeOrigin", performance.timeOrigin);
  }

  // Web Streams used bare (not window-prefixed) by data/compress.ts at module-eval time.
  for (const g of ["CompressionStream", "ReadableStream", "Response", "TextEncoderStream", "WritableStream", "TransformStream"] as const) {
    const value = (globalThis as Record<string, unknown>)[g];
    if (value && !(window as unknown as Record<string, unknown>)[g]) force(window, g, value);
  }

  // crypto.subtle (identify SHA-256) + getRandomValues (short ids).
  if (!window.crypto || !window.crypto.subtle) force(window, "crypto", globalThis.crypto);

  // Deterministic idle-callback so the cooperative scheduler (core/task.ts) drains fully.
  force(window, "requestIdleCallback", (cb: (d: { didTimeout: boolean; timeRemaining: () => number }) => void) =>
    setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 1e9 }), 0),
  );
  force(window, "cancelIdleCallback", (id: number) => clearTimeout(id));

  // CRITICAL: jsdom lacks adoptedStyleSheets → layout/style.ts short-circuits before assigning the
  // document its node id, which cascades to the ENTIRE DOM tree being dropped by the detached-node
  // guard in layout/dom.ts. Empty array lets discover register all nodes.
  if (!window.document.adoptedStyleSheets) force(window.document, "adoptedStyleSheets", []);

  // Mutable scroll state (interaction/scroll.ts reads window.pageXOffset/pageYOffset).
  force(window, "pageXOffset", 0);
  force(window, "pageYOffset", 0);
  force(window, "scrollX", 0);
  force(window, "scrollY", 0);
}

// Assert required globals are present immediately before evaluating the library. Throws loudly so a
// missing shim fails fast instead of silently degrading capture.
export function assertReady(window: DOMWindow): void {
  const missing = REQUIRED_GLOBALS.filter((g) => (window as unknown as Record<string, unknown>)[g] == null);
  if (missing.length > 0) throw new Error(`unclarity: realm missing required globals before eval: ${missing.join(", ")}`);
}

// Update the realm's scroll position (used by the scroll action before dispatching a scroll event).
export function setScroll(window: DOMWindow, y: number, x = 0): void {
  force(window, "pageXOffset", x);
  force(window, "pageYOffset", y);
  force(window, "scrollX", x);
  force(window, "scrollY", y);
  window.document.documentElement.scrollTop = y;
  window.document.documentElement.scrollLeft = x;
}
