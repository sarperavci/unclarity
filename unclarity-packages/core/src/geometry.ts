import type { DOMWindow } from "jsdom";
import { force } from "./util.js";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Per-uc-id geometry supplied by a captured/authored Bundle (M2). Keyed by the data-uc-id attribute.
export type GeometryMap = Record<string, Box>;

export interface GeometryOptions {
  viewport: { width: number; height: number };
  docHeight: number;
  // Optional explicit geometry by data-uc-id. When absent, a deterministic block-flow
  // fallback assigns non-degenerate boxes so clarity's rect>0 guards pass.
  byId?: GeometryMap;
}

// jsdom has no layout engine: getBoundingClientRect/offset* all return 0, which makes clarity's
// click/region capture degenerate AND produces payloads the ingestion endpoint rejects. The oracle
// answers layout queries consistently with a real render.
export function installGeometryOracle(window: DOMWindow, opts: GeometryOptions): void {
  const { document } = window;
  const geo = new WeakMap<Element, Box>();
  const ordered: Array<{ el: Element; box: Box }> = [];

  const fallbackBox = (el: Element, cursorY: number): Box => {
    const tag = el.tagName;
    const height = tag === "BUTTON" || tag === "INPUT" || tag === "A" ? 40 : tag === "H1" ? 48 : 24;
    const width = tag === "BUTTON" ? 160 : tag === "INPUT" ? 260 : Math.min(opts.viewport.width - 32, 1200);
    return { x: 16, y: cursorY, width, height };
  };

  let cursorY = 0;
  // Tags a real browser never returns from elementFromPoint — keep them out of the hit-test list so a
  // click coordinate can't resolve to a <head>/<script>/<meta> node (M2).
  const NON_RENDERED = new Set(["HEAD", "META", "SCRIPT", "STYLE", "TITLE", "LINK", "BASE", "NOSCRIPT", "HTML"]);
  const walker = document.createTreeWalker(document.documentElement, window.NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.currentNode;
  while (node) {
    const el = node as Element;
    let box: Box | undefined;
    const ucId = el.getAttribute?.("data-uc-id");
    if (ucId && opts.byId?.[ucId]) {
      box = opts.byId[ucId];
    } else {
      box = fallbackBox(el, cursorY);
      cursorY += box.height + 8;
    }
    geo.set(el, box); // every element answers getBoundingClientRect/offset*
    if (!NON_RENDERED.has(el.tagName)) ordered.push({ el, box }); // but only rendered ones are hit-testable
    // Strip the join key now that it's recorded — a leaked data-uc-id would be captured by clarity
    // as a per-node attribute (a synthetic tell). Strip on EVERY element, rendered or not.
    el.removeAttribute?.("data-uc-id");
    node = walker.nextNode();
  }

  const scrollX = (): number => (window.pageXOffset as number) || 0;
  const scrollY = (): number => (window.pageYOffset as number) || 0;
  const DEFAULT: Box = { x: 16, y: 0, width: 1200, height: 24 };

  const rectFor = (el: Element): DOMRect => {
    const b = geo.get(el) ?? DEFAULT;
    const left = b.x - scrollX();
    const top = b.y - scrollY();
    return {
      x: left,
      y: top,
      left,
      top,
      width: b.width,
      height: b.height,
      right: left + b.width,
      bottom: top + b.height,
      toJSON() {
        return this;
      },
    } as DOMRect;
  };

  window.Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    return rectFor(this);
  };
  const defGetter = (key: string, get: (el: Element) => number): void => {
    Object.defineProperty(window.HTMLElement.prototype, key, {
      configurable: true,
      get(this: Element) {
        return get(this);
      },
    });
  };
  defGetter("offsetWidth", (el) => (geo.get(el) ?? DEFAULT).width);
  defGetter("offsetHeight", (el) => (geo.get(el) ?? DEFAULT).height);
  defGetter("offsetLeft", (el) => (geo.get(el) ?? DEFAULT).x);
  defGetter("offsetTop", (el) => (geo.get(el) ?? DEFAULT).y);
  Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return document.body;
    },
  });

  for (const el of [document.documentElement, document.body]) {
    for (const [k, v] of [
      ["clientWidth", opts.viewport.width],
      ["clientHeight", opts.viewport.height],
      ["scrollWidth", opts.viewport.width],
      ["scrollHeight", opts.docHeight],
      ["offsetWidth", opts.viewport.width],
      ["offsetHeight", opts.docHeight],
    ] as const) {
      try {
        Object.defineProperty(el, k, { value: v, configurable: true });
      } catch {
        /* element may already define it */
      }
    }
  }

  force(window, "innerWidth", opts.viewport.width);
  force(window, "innerHeight", opts.viewport.height);

  force(document, "elementFromPoint", (x: number, y: number): Element => {
    const px = x + scrollX();
    const py = y + scrollY();
    for (let i = ordered.length - 1; i >= 0; i--) {
      const entry = ordered[i]!;
      const b = entry.box;
      if (px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height) return entry.el;
    }
    return document.body;
  });
  force(document, "caretRangeFromPoint", () => null);
}
