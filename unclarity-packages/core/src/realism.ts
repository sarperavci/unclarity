import type { Box } from "./geometry.js";
import type { Rng } from "./prng.js";

export interface PathPoint {
  x: number;
  y: number;
  dt: number; // ms since previous point
}

// clarity decimates pointer moves within 20px/25ms (pointer.ts) — so we generate a continuous-ish
// path then DECIMATE to that grid. A dense path records MORE robotically, not less.
export function decimate(points: PathPoint[], minDist = 20, minTime = 25): PathPoint[] {
  if (points.length === 0) return [];
  const out: PathPoint[] = [points[0]!];
  let last = points[0]!;
  let carriedTime = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    carriedTime += p.dt;
    const dist = Math.hypot(p.x - last.x, p.y - last.y);
    if (dist >= minDist || carriedTime >= minTime) {
      out.push({ x: p.x, y: p.y, dt: carriedTime });
      last = p;
      carriedTime = 0;
    }
  }
  const tail = points[points.length - 1]!;
  if (out[out.length - 1] !== tail) out.push({ x: tail.x, y: tail.y, dt: carriedTime });
  return out;
}

// Human-ish cursor path: eased interpolation with small gaussian jitter, then decimated.
export function mousePath(from: { x: number; y: number }, to: { x: number; y: number }, rng: Rng, steps = 24): PathPoint[] {
  const raw: PathPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // easeInOutQuad
    const jitter = i === 0 || i === steps ? 0 : rng.gaussian(0, 1.5);
    raw.push({
      x: Math.round(from.x + (to.x - from.x) * ease + jitter),
      y: Math.round(from.y + (to.y - from.y) * ease + jitter),
      dt: i === 0 ? 0 : Math.max(4, Math.round(rng.logNormal(12, 0.4))),
    });
  }
  return decimate(raw);
}

// Center-biased gaussian click point inside a box (so clarity's eX/eY land believably).
export function clickPlacement(box: Box, rng: Rng): { x: number; y: number } {
  const x = rng.gaussian(box.x + box.width / 2, box.width / 6);
  const y = rng.gaussian(box.y + box.height / 2, box.height / 6);
  return {
    x: Math.round(Math.max(box.x + 1, Math.min(box.x + box.width - 1, x))),
    y: Math.round(Math.max(box.y + 1, Math.min(box.y + box.height - 1, y))),
  };
}

export interface KeyPlan {
  char: string;
  delay: number;
}

// Per-character typing plan with human cadence (~wpm) and occasional longer pauses.
export function typingPlan(text: string, rng: Rng, wpm = 200): KeyPlan[] {
  const base = 60000 / (wpm * 5); // ms per char
  return [...text].map((char) => ({ char, delay: Math.max(20, Math.round(rng.logNormal(base, 0.45))) }));
}

export type ArchetypeName = "bouncer" | "browser" | "converter" | "rageClicker";

// Weighted session shapes — the scenario runner (M5) expands these into concrete actions.
export const ARCHETYPES: Record<ArchetypeName, { scrolls: number; clicks: number; types: number; weight: number }> = {
  bouncer: { scrolls: 1, clicks: 0, types: 0, weight: 0.35 },
  browser: { scrolls: 4, clicks: 2, types: 0, weight: 0.4 },
  converter: { scrolls: 5, clicks: 4, types: 1, weight: 0.2 },
  rageClicker: { scrolls: 2, clicks: 6, types: 0, weight: 0.05 },
};

export function pickArchetype(rng: Rng): ArchetypeName {
  const entries = Object.entries(ARCHETYPES) as Array<[ArchetypeName, { weight: number }]>;
  const total = entries.reduce((s, [, v]) => s + v.weight, 0);
  let r = rng.next() * total;
  for (const [name, v] of entries) {
    r -= v.weight;
    if (r <= 0) return name;
  }
  return "browser";
}
