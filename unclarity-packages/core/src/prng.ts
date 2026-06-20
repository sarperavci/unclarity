// Deterministic seeded PRNG (mulberry32). Pure uint32 math so the Python client can reproduce the
// exact same bit stream from the same seed (verified by shared golden vectors). Never Math.random.
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. Returns min if the range is inverted/empty. */
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Gaussian via Box-Muller, clamped to [mean-3σ, mean+3σ]. */
  gaussian(mean: number, stdev: number): number {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const v = mean + z * stdev;
    return Math.max(mean - 3 * stdev, Math.min(mean + 3 * stdev, v));
  }

  /** Log-normal think-time-style positive value. */
  logNormal(mean: number, stdev: number): number {
    return Math.exp(this.gaussian(Math.log(mean), stdev));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick: empty array");
    return items[this.int(0, items.length - 1)]!;
  }

  /** Independent sub-stream so tuning one concern doesn't shift another. */
  substream(streamId: number): Rng {
    return new Rng((this.state ^ Math.imul(streamId, 0x9e3779b1)) >>> 0);
  }
}
