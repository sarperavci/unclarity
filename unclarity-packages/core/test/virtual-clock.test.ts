import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/index.js";

const realm = (): Window => new JSDOM("<!doctype html><body></body>").window as unknown as Window;

describe("VirtualClock", () => {
  it("setInterval fires repeatedly and clearInterval stops it (M5)", async () => {
    const window = realm();
    const clock = new VirtualClock(1);
    clock.install(window as never);
    let n = 0;
    const id = window.setInterval(() => n++, 100);
    await clock.advance(350);
    expect(n).toBe(3);
    window.clearInterval(id);
    await clock.advance(500);
    expect(n).toBe(3);
  });

  it("setTimeout fires once at the right virtual time", async () => {
    const window = realm();
    const clock = new VirtualClock(1);
    clock.install(window as never);
    let fired = false;
    window.setTimeout(() => {
      fired = true;
    }, 50);
    await clock.advance(40);
    expect(fired).toBe(false);
    await clock.advance(20);
    expect(fired).toBe(true);
  });

  it("advance throws on a 0ms self-rescheduling runaway instead of silently truncating (M6)", async () => {
    const window = realm();
    const clock = new VirtualClock(1);
    clock.install(window as never);
    const tick = (): void => {
      window.setTimeout(tick, 0);
    };
    window.setTimeout(tick, 0);
    await expect(clock.advance(1)).rejects.toThrow(/runaway/i);
  }, 20000);
});
