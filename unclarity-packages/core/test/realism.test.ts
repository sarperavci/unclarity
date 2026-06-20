import { describe, expect, it } from "vitest";
import { Rng, decimate, mousePath, clickPlacement, typingPlan, pickArchetype } from "../src/index.js";
import type { PathPoint } from "../src/index.js";

describe("Rng", () => {
  it("is deterministic for a given seed (golden vector)", () => {
    const a = new Rng(42);
    const seq = [a.next(), a.next(), a.next()].map((n) => Math.round(n * 1e6));
    // mulberry32(42) first three outputs — frozen so the Python client can match bit-for-bit.
    expect(seq).toEqual([601104, 448291, 852466]);
  });

  it("two instances with the same seed produce identical streams", () => {
    const a = new Rng(7);
    const b = new Rng(7);
    expect(Array.from({ length: 50 }, () => a.next())).toEqual(Array.from({ length: 50 }, () => b.next()));
  });

  it("substreams are independent of each other", () => {
    const root = new Rng(123);
    const s1 = root.substream(1).next();
    const s2 = root.substream(2).next();
    expect(s1).not.toEqual(s2);
  });
});

describe("decimate", () => {
  it("collapses points closer than the 20px/25ms grid", () => {
    const dense: PathPoint[] = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 0, dt: 1 }));
    const out = decimate(dense, 20, 25);
    // 100px over 100ms → ~ every 20px or 25ms, far fewer than 100 points
    expect(out.length).toBeLessThan(20);
    expect(out.length).toBeGreaterThan(1);
  });
});

describe("realism generators", () => {
  it("mousePath is decimated and ends at the target", () => {
    const rng = new Rng(1);
    const path = mousePath({ x: 0, y: 0 }, { x: 300, y: 200 }, rng);
    expect(path.length).toBeGreaterThan(1);
    const last = path[path.length - 1]!;
    expect(last.x).toBe(300);
    expect(last.y).toBe(200);
    // H2: no zero-dt duplicate of the final coordinate (the robotic tell)
    const prev = path[path.length - 2]!;
    expect(prev.x === last.x && prev.y === last.y && last.dt === 0).toBe(false);
  });

  it("decimate folds residual time into the tail instead of duplicating it", () => {
    const out = decimate([
      { x: 0, y: 0, dt: 0 },
      { x: 5, y: 0, dt: 10 },
    ]);
    // last point is (5,0); must not appear twice
    const last = out[out.length - 1]!;
    expect(last.x).toBe(5);
    expect(out.filter((p) => p.x === 5 && p.y === 0).length).toBe(1);
  });

  it("clickPlacement handles a 1px box without escaping it", () => {
    const p = clickPlacement({ x: 100, y: 50, width: 1, height: 1 }, new Rng(4));
    expect(p.x).toBeGreaterThanOrEqual(100);
    expect(p.x).toBeLessThanOrEqual(101);
    expect(p.y).toBeGreaterThanOrEqual(50);
    expect(p.y).toBeLessThanOrEqual(51);
  });

  it("clickPlacement stays inside the box", () => {
    const rng = new Rng(9);
    for (let i = 0; i < 100; i++) {
      const p = clickPlacement({ x: 100, y: 50, width: 140, height: 40 }, rng);
      expect(p.x).toBeGreaterThanOrEqual(100);
      expect(p.x).toBeLessThanOrEqual(240);
      expect(p.y).toBeGreaterThanOrEqual(50);
      expect(p.y).toBeLessThanOrEqual(90);
    }
  });

  it("typingPlan yields one entry per char with positive delays", () => {
    const plan = typingPlan("hello", new Rng(3));
    expect(plan.map((k) => k.char).join("")).toBe("hello");
    expect(plan.every((k) => k.delay >= 20)).toBe(true);
  });

  it("pickArchetype returns a known archetype", () => {
    expect(["bouncer", "browser", "converter", "rageClicker"]).toContain(pickArchetype(new Rng(5)));
  });
});
