import type { Box } from "./geometry.js";
import type { Rng } from "./prng.js";

// clarity's pointer/scroll dedup grid (pointer.ts 20px/25ms) — paths are generated then decimated to it.
const DEDUP_MIN_DIST_PX = 20;
const DEDUP_MIN_TIME_MS = 25;
// Cursor-path tuning.
const PATH_STEPS = 24;
const PATH_JITTER_PX = 1.5; // per-step gaussian wobble
const PATH_STEP_MEAN_MS = 12; // mean inter-sample delay
const PATH_STEP_SIGMA = 0.4;
const PATH_STEP_MIN_MS = 4;
const CLICK_SPREAD_DIVISOR = 6; // gaussian σ = box size / this, keeps clicks near center
const TYPING_WPM = 200;
const TYPING_SIGMA = 0.45;
const TYPING_MIN_MS = 20;

export interface PathPoint {
  x: number;
  y: number;
  dt: number; // ms since previous point
}

// clarity decimates pointer moves within 20px/25ms (pointer.ts) — so we generate a continuous-ish
// path then DECIMATE to that grid. A dense path records MORE robotically, not less.
export function decimate(points: PathPoint[], minDist = DEDUP_MIN_DIST_PX, minTime = DEDUP_MIN_TIME_MS): PathPoint[] {
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
  // Ensure the path ends exactly at the tail without appending a zero-dt duplicate. If the last kept
  // point is already at the tail's coordinates, fold any residual time into it instead of pushing a
  // duplicate sample (the duplicate was the robotic tell this function exists to avoid).
  const lastOut = out[out.length - 1]!;
  const tail = points[points.length - 1]!;
  if (lastOut.x !== tail.x || lastOut.y !== tail.y) {
    out.push({ x: tail.x, y: tail.y, dt: carriedTime });
  } else if (carriedTime > 0) {
    out[out.length - 1] = { ...lastOut, dt: lastOut.dt + carriedTime };
  }
  return out;
}

// Human-ish cursor path: eased interpolation with small gaussian jitter, then decimated.
export function mousePath(from: { x: number; y: number }, to: { x: number; y: number }, rng: Rng, steps = PATH_STEPS): PathPoint[] {
  const raw: PathPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // easeInOutQuad
    const jitter = i === 0 || i === steps ? 0 : rng.gaussian(0, PATH_JITTER_PX);
    raw.push({
      x: Math.round(from.x + (to.x - from.x) * ease + jitter),
      y: Math.round(from.y + (to.y - from.y) * ease + jitter),
      dt: i === 0 ? 0 : Math.max(PATH_STEP_MIN_MS, Math.round(rng.logNormal(PATH_STEP_MEAN_MS, PATH_STEP_SIGMA))),
    });
  }
  return decimate(raw);
}

// Center-biased gaussian click point inside a box (so clarity's eX/eY land believably).
export function clickPlacement(box: Box, rng: Rng): { x: number; y: number } {
  // Clamp into [lo, hi]; for degenerate (<=2px) boxes the bounds can invert, so fall back to center.
  const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
  const x = rng.gaussian(box.x + box.width / 2, box.width / CLICK_SPREAD_DIVISOR);
  const y = rng.gaussian(box.y + box.height / 2, box.height / CLICK_SPREAD_DIVISOR);
  return {
    x: Math.round(clamp(x, box.x + 1, box.x + box.width - 1)),
    y: Math.round(clamp(y, box.y + 1, box.y + box.height - 1)),
  };
}

export interface KeyPlan {
  char: string;
  delay: number;
}

// Per-character typing plan with human cadence (~wpm) and occasional longer pauses.
export function typingPlan(text: string, rng: Rng, wpm = TYPING_WPM): KeyPlan[] {
  const base = 60000 / (wpm * 5); // ms per char (5 chars/word convention)
  return [...text].map((char) => ({ char, delay: Math.max(TYPING_MIN_MS, Math.round(rng.logNormal(base, TYPING_SIGMA))) }));
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
