import type { DOMWindow } from "jsdom";
import { Rng } from "./prng.js";
import { force } from "./util.js";

interface VTimer {
  id: number;
  fireAt: number;
  cb: () => void;
  cleared: boolean;
}

// Deterministic virtual time: overrides setTimeout/performance/Date/Math.random/requestIdleCallback
// in a realm so every time- and randomness-derived value clarity produces is reproducible from a
// seed. Time only advances when advance() is called, so a given scenario yields byte-identical
// payloads run to run. Use with callback upload (no real network) and uncompressed payloads.
export class VirtualClock {
  private t = 0;
  private timers: VTimer[] = [];
  private seq = 1;
  private readonly rng: Rng;
  readonly origin: number;

  constructor(seed: number, origin = 1_700_000_000_000) {
    this.rng = new Rng((seed ^ 0x1234abcd) >>> 0);
    this.origin = origin;
  }

  now(): number {
    return this.t;
  }

  private schedule(cb: () => void, ms?: number): number {
    const id = this.seq++;
    this.timers.push({ id, fireAt: this.t + Math.max(0, ms ?? 0), cb, cleared: false });
    return id;
  }

  private cancel(id: number): void {
    const tm = this.timers.find((t) => t.id === id);
    if (tm) tm.cleared = true;
  }

  private async drainMicrotasks(): Promise<void> {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }

  // Advance virtual time by `ms`, firing every timer due in that window in (fireAt, id) order and
  // draining microtasks between fires so async continuations settle deterministically.
  async advance(ms: number): Promise<void> {
    const target = this.t + Math.max(0, ms);
    let guard = 0;
    while (guard++ < 1_000_000) {
      let due: VTimer | undefined;
      for (const tm of this.timers) {
        if (tm.cleared || tm.fireAt > target) continue;
        if (!due || tm.fireAt < due.fireAt || (tm.fireAt === due.fireAt && tm.id < due.id)) due = tm;
      }
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = due.fireAt;
      try {
        due.cb();
      } catch {
        /* a thrown timer callback must not stop the clock (matches real timer semantics) */
      }
      await this.drainMicrotasks();
    }
    this.t = target;
    await this.drainMicrotasks();
  }

  install(window: DOMWindow): void {
    force(window, "setTimeout", (cb: () => void, ms?: number) => this.schedule(cb, ms));
    force(window, "clearTimeout", (id: number) => this.cancel(id));
    force(window, "setInterval", () => 0); // clarity doesn't use it; no-op avoids runaway during advance
    force(window, "clearInterval", () => undefined);
    force(window, "requestIdleCallback", (cb: (d: { didTimeout: boolean; timeRemaining: () => number }) => void) =>
      this.schedule(() => cb({ didTimeout: false, timeRemaining: () => 1e9 }), 0),
    );
    force(window, "cancelIdleCallback", (id: number) => this.cancel(id));
    force(window, "requestAnimationFrame", (cb: (t: number) => void) => this.schedule(() => cb(this.t), 16));
    force(window, "cancelAnimationFrame", (id: number) => this.cancel(id));

    force(window.performance, "now", () => this.t);
    force(window.performance, "timeOrigin", this.origin);

    const RealDate = window.Date;
    const origin = this.origin;
    const clk = this;
    class VDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(origin + clk.t);
        else super(...(args as [number]));
      }
      static override now(): number {
        return origin + clk.t;
      }
    }
    force(window, "Date", VDate);

    force(window.Math, "random", () => this.rng.next());
  }
}
