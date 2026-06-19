import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import type { GeometryMap } from "./geometry.js";

export type GeometryMode = "provided" | "captured" | "inferred";

export interface BundleManifest {
  sourceUrl?: string;
  viewport: { width: number; height: number };
  dpr: number;
  docHeight: number;
  geometryMode: GeometryMode;
  capturedAt?: string;
}

export interface LoadedBundle {
  html: string;
  manifest: BundleManifest;
  geometry: GeometryMap;
}

const MANIFEST = "manifest.json";
const DOM_HTML = "dom.html";
const GEOMETRY = "geometry.json";

// Write the three bundle files. Shared by manual authoring and Playwright capture.
export async function writeBundle(outDir: string, html: string, manifest: BundleManifest, geometry: GeometryMap): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, DOM_HTML), html);
  await writeFile(join(outDir, MANIFEST), JSON.stringify(manifest, null, 2));
  await writeFile(join(outDir, GEOMETRY), JSON.stringify({ byId: geometry, viewport: manifest.viewport, docHeight: manifest.docHeight }, null, 2));
}

// A Bundle is the single replay artifact, hand-authorable AND capture-producible. Node + Python read
// the identical files (language-neutral JSON + HTML).
export async function loadBundle(dir: string): Promise<LoadedBundle> {
  for (const f of [MANIFEST, DOM_HTML]) {
    if (!existsSync(join(dir, f))) throw new Error(`bundle ${dir}: missing ${f}`);
  }
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as BundleManifest;
  const html = await readFile(join(dir, DOM_HTML), "utf8");
  let geometry: GeometryMap = {};
  if (existsSync(join(dir, GEOMETRY))) {
    const parsed = JSON.parse(await readFile(join(dir, GEOMETRY), "utf8")) as { byId?: GeometryMap };
    geometry = parsed.byId ?? {};
  }
  return { html, manifest, geometry };
}

export interface AuthorOptions {
  html: string;
  sourceUrl?: string;
  viewport?: { width: number; height: number };
  dpr?: number;
  docHeight?: number;
  // Optional explicit geometry keyed by data-uc-id (mode "provided"). Omit → "inferred".
  geometry?: GeometryMap;
}

// Author a Bundle from raw HTML (the PRIMARY manual-feed path). Stamps a stable data-uc-id on every
// element (the join key for geometry), then writes the artifact.
export async function authorBundle(opts: AuthorOptions, outDir: string): Promise<BundleManifest> {
  const dom = new JSDOM(opts.html);
  const { document } = dom.window;
  let counter = 1;
  const walker = document.createTreeWalker(document.documentElement, dom.window.NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.currentNode;
  while (node) {
    (node as Element).setAttribute("data-uc-id", String(counter++));
    node = walker.nextNode();
  }
  const manifest: BundleManifest = {
    ...(opts.sourceUrl !== undefined ? { sourceUrl: opts.sourceUrl } : {}),
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    dpr: opts.dpr ?? 1,
    docHeight: opts.docHeight ?? 3000,
    geometryMode: opts.geometry ? "provided" : "inferred",
  };
  await writeBundle(outDir, dom.serialize(), manifest, opts.geometry ?? {});
  return manifest;
}

// Validate a bundle on disk; throws on the first structural problem.
export async function validateBundle(dir: string): Promise<void> {
  const { manifest, geometry } = await loadBundle(dir);
  if (!manifest.viewport || manifest.viewport.width <= 0 || manifest.viewport.height <= 0) {
    throw new Error(`bundle ${dir}: invalid viewport`);
  }
  if (!["provided", "captured", "inferred"].includes(manifest.geometryMode)) {
    throw new Error(`bundle ${dir}: invalid geometryMode ${manifest.geometryMode}`);
  }
  if (manifest.geometryMode !== "inferred" && Object.keys(geometry).length === 0) {
    throw new Error(`bundle ${dir}: geometryMode is ${manifest.geometryMode} but geometry.byId is empty`);
  }
  for (const [id, box] of Object.entries(geometry)) {
    if (box.width <= 0 || box.height <= 0) throw new Error(`bundle ${dir}: degenerate box for uc-id ${id}`);
  }
}
