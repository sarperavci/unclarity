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

// Tags a real browser never returns from elementFromPoint — kept out of the hit-test list so a click
// coordinate can't resolve to a <head>/<script>/<meta> node (M2).
const NON_RENDERED = new Set(["HEAD", "META", "SCRIPT", "STYLE", "TITLE", "LINK", "BASE", "NOSCRIPT", "HTML"]);
const DEFAULT_BOX: Box = { x: 16, y: 0, width: 1200, height: 24 };
const FLOW_GAP = 8; // vertical px between stacked fallback boxes

// jsdom has no layout engine: getBoundingClientRect/offset* all return 0, which makes clarity's
// click/region capture degenerate AND produces payloads the ingestion endpoint rejects. The oracle
// answers layout queries consistently with a real render, in three phases.
//
// INVARIANT: patches the realm's shared Element/HTMLElement prototypes — install AT MOST ONCE per
// realm (we hold one clarity instance per realm, so this is safe).
export function installGeometryOracle(window: DOMWindow, opts: GeometryOptions): void {
  const { document } = window;
  const geo = new WeakMap<Element, Box>();
  const ordered: Array<{ el: Element; box: Box }> = [];
  const scrollX = (): number => (window.pageXOffset as number) || 0;
  const scrollY = (): number => (window.pageYOffset as number) || 0;
  const boxOf = (el: Element): Box => geo.get(el) ?? DEFAULT_BOX;

  assignBoxes();
  patchLayoutQueries();
  installHitTest();

  // Phase 1 — assign each element a box (provided geometry, else block-flow fallback), record
  // rendered elements for hit-testing, and strip the data-uc-id join key so it isn't captured.
  function assignBoxes(): void {
    const fallbackBox = (el: Element, cursorY: number): Box => {
      const tag = el.tagName;
      const height = tag === "BUTTON" || tag === "INPUT" || tag === "A" ? 40 : tag === "H1" ? 48 : 24;
      const width = tag === "BUTTON" ? 160 : tag === "INPUT" ? 260 : Math.min(opts.viewport.width - 32, 1200);
      return { x: 16, y: cursorY, width, height };
    };
    let cursorY = 0;
    const walker = document.createTreeWalker(document.documentElement, window.NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode;
    while (node) {
      const el = node as Element;
      const ucId = el.getAttribute?.("data-uc-id");
      let box: Box;
      if (ucId && opts.byId?.[ucId]) {
        box = opts.byId[ucId];
      } else {
        box = fallbackBox(el, cursorY);
        cursorY += box.height + FLOW_GAP;
      }
      geo.set(el, box); // every element answers getBoundingClientRect/offset*
      if (!NON_RENDERED.has(el.tagName)) ordered.push({ el, box }); // but only rendered ones are hit-testable
      el.removeAttribute?.("data-uc-id"); // strip on EVERY element — a leak is a per-node tell
      node = walker.nextNode();
    }
  }

  // Phase 2 — patch the layout queries clarity reads: getBoundingClientRect, offset*, document/body
  // client/scroll/offset dims, and window inner size.
  function patchLayoutQueries(): void {
    window.Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const b = boxOf(this);
      const left = b.x - scrollX();
      const top = b.y - scrollY();
      return { x: left, y: top, left, top, width: b.width, height: b.height, right: left + b.width, bottom: top + b.height, toJSON() { return this; } } as DOMRect;
    };
    const defGetter = (key: string, get: (el: Element) => number): void => {
      Object.defineProperty(window.HTMLElement.prototype, key, { configurable: true, get(this: Element) { return get(this); } });
    };
    defGetter("offsetWidth", (el) => boxOf(el).width);
    defGetter("offsetHeight", (el) => boxOf(el).height);
    defGetter("offsetLeft", (el) => boxOf(el).x);
    defGetter("offsetTop", (el) => boxOf(el).y);
    Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { configurable: true, get() { return document.body; } });

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
  }

  // Phase 3 — synthesize elementFromPoint / caretRangeFromPoint from the rendered hit-test list.
  function installHitTest(): void {
    force(document, "elementFromPoint", (x: number, y: number): Element => {
      const px = x + scrollX();
      const py = y + scrollY();
      for (let i = ordered.length - 1; i >= 0; i--) {
        const { el, box } = ordered[i]!;
        if (px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height) return el;
      }
      return document.body;
    });
    force(document, "caretRangeFromPoint", () => null);
  }
}
