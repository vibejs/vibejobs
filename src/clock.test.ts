import { afterEach, expect, it, vi } from "vitest";
import { systemClock } from "./clock.ts";

afterEach(() => {
  vi.useRealTimers();
});

it("ticks until it is stopped", () => {
  vi.useFakeTimers();
  const clock = systemClock();
  let ticks = 0;
  const stop = clock.every(10, () => {
    ticks += 1;
  });
  vi.advanceTimersByTime(25);
  expect(ticks).toBe(2);
  stop();
  vi.advanceTimersByTime(20);
  expect(ticks).toBe(2);
  expect(clock.now()).toBe(Date.now());
});
