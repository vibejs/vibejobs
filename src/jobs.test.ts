import { JsonLogger, Module } from "@usevibejs/server";
import { VibeFactory } from "@usevibejs/server";
import { describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import { JOBS_HANDLER_MISSING, JOBS_INVALID, JOBS_INVALID_PAYLOAD, JobsError } from "./errors.ts";
import { Jobs } from "./jobs.ts";
import { memoryDriver } from "./memory.ts";
import { JOBS, JobsModule } from "./module.ts";
import { retryDelay, type JobDriver } from "./index.ts";

function clock(start = Date.UTC(2024, 0, 1, 8, 30)): Clock & { at: number; fire: () => void } {
  let fn: (() => void) | undefined;
  const state = {
    at: start,
    now: () => state.at,
    every(_ms: number, callback: () => void) {
      fn = callback;
      return () => {
        fn = undefined;
      };
    },
    fire() {
      fn?.();
    },
  };
  return state;
}

function jobs(
  options: { baseDelayMs?: number; onError?: (error: unknown) => void; driver?: JobDriver } = {},
) {
  const time = clock();
  const runner = new Jobs({
    driver: options.driver ?? memoryDriver(),
    clock: time,
    intervalMs: 25,
    baseDelayMs: options.baseDelayMs ?? 0,
    onError: options.onError,
  });
  return { runner, time };
}

describe("Jobs", () => {
  it("runs due work, deduplicates a key, and retries until the job is dead", async () => {
    const { runner, time } = jobs();
    const seen: unknown[] = [];
    let fails = 0;
    runner.handle("send", (payload) => {
      seen.push(payload);
      fails += 1;
      if (fails < 2) throw new Error("later");
    });
    const first = await runner.enqueue(
      "send",
      { n: 1 },
      { idempotencyKey: "once", maxAttempts: 2 },
    );
    const second = await runner.enqueue("send", { n: 1 }, { idempotencyKey: "once" });
    expect(second.id).toBe(first.id);
    await runner.tick();
    expect(seen).toEqual([{ n: 1 }, { n: 1 }]);
    let nested = false;
    runner.handle("nested", async () => {
      await runner.tick();
      nested = true;
      throw 1;
    });
    await runner.enqueue("nested", { ok: true }, { maxAttempts: 1 });
    await runner.tick();
    expect(nested).toBe(true);
    await runner.enqueue("missing", {});
    await runner.tick();
    expect(retryDelay(1, 50)).toBe(50);
    expect(retryDelay(0, 50)).toBe(50);
    expect(retryDelay(9, 50)).toBe(50 * 2 ** 7);
    expect(time.at).toBeGreaterThan(0);
  });

  it("enqueues cron work once per matching minute and stops with the server", async () => {
    const time = clock();
    let runs = 0;
    @Module({
      imports: [
        JobsModule.forRoot({ driver: memoryDriver(), clock: time, intervalMs: 10, baseDelayMs: 0 }),
      ],
    })
    class AppModule {}
    const app = await VibeFactory.create(AppModule, {
      logger: new JsonLogger({ level: "silent" }),
    });
    const queue = app.get(JOBS);
    queue.handle("beat", () => {
      runs += 1;
    });
    queue.schedule("* * * * *", "beat", { ok: true });
    queue.schedule("0 0 1 1 0", "beat", { ok: false });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    time.fire();
    await flush();
    expect(runs).toBe(1);
    time.fire();
    await flush();
    expect(runs).toBe(1);
    time.at += 60_000;
    time.fire();
    await flush();
    expect(runs).toBe(2);
    await app.close();
    time.fire();
    await flush();
    expect(runs).toBe(2);
  });

  it("rejects bad names, payloads, and timing", async () => {
    const { runner } = jobs();
    expect(() => runner.handle("  ", () => {})).toThrow(
      expect.objectContaining({ code: JOBS_INVALID }),
    );
    await expect(runner.enqueue("  ", {})).rejects.toMatchObject({ code: JOBS_INVALID });
    await expect(runner.enqueue("send", {}, { idempotencyKey: "  " })).rejects.toMatchObject({
      code: JOBS_INVALID,
    });
    await expect(runner.enqueue("send", {}, { maxAttempts: 0 })).rejects.toMatchObject({
      code: JOBS_INVALID,
    });
    await expect(runner.enqueue("send", {}, { maxAttempts: 1.5 })).rejects.toMatchObject({
      code: JOBS_INVALID,
    });
    await expect(runner.enqueue("send", {}, { runAt: Number.NaN })).rejects.toMatchObject({
      code: JOBS_INVALID,
    });
    await expect(runner.enqueue("send", undefined)).rejects.toMatchObject({
      code: JOBS_INVALID_PAYLOAD,
    });
    const circular: { self?: object } = {};
    circular.self = circular;
    await expect(runner.enqueue("send", circular)).rejects.toMatchObject({
      code: JOBS_INVALID_PAYLOAD,
    });
    await expect(runner.enqueue("send", () => 1)).rejects.toMatchObject({
      code: JOBS_INVALID_PAYLOAD,
    });
    expect(() => runner.schedule("* * *", "send", {})).toThrow(
      expect.objectContaining({ code: "JOBS_INVALID_CRON" }),
    );
    expect(() => runner.schedule("nope * * * *", "  ", {})).toThrow(
      expect.objectContaining({ code: JOBS_INVALID }),
    );
    expect(() => new Jobs({ driver: memoryDriver(), intervalMs: 0 })).toThrow(
      expect.objectContaining({ code: JOBS_INVALID }),
    );
    expect(() => new Jobs({ driver: memoryDriver(), baseDelayMs: -1 })).toThrow(
      expect.objectContaining({ code: JOBS_INVALID }),
    );
    expect(() => new Jobs({ driver: memoryDriver(), intervalMs: 1.2 })).toThrow(
      expect.objectContaining({ code: JOBS_INVALID }),
    );
    const defaults = new Jobs({ driver: memoryDriver() });
    await defaults.enqueue("send", { ok: true });
    expect(new JobsError(JOBS_HANDLER_MISSING, "x").name).toBe("JobsError");
    expect(() => JobsModule.forRoot({ driver: undefined as never })).toThrow(
      expect.objectContaining({ code: JOBS_INVALID }),
    );
    expect(() => JobsModule.forRoot({ driver: { put: "no" } as never })).toThrow(/driver/);
  });

  it("reports a worker failure to onError and ignores it by default", async () => {
    const errors: unknown[] = [];
    const broken: JobDriver = {
      async setup() {},
      async put(job) {
        return job;
      },
      async claim() {
        throw new Error("claim");
      },
      async complete() {},
      async reschedule() {},
      async dead() {},
    };
    const custom = jobs({ driver: broken, onError: (error) => errors.push(error) });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    custom.runner.start();
    custom.time.fire();
    await flush();
    expect(errors).toEqual([expect.objectContaining({ message: "claim" })]);
    const quiet = jobs({ driver: broken });
    quiet.runner.start();
    quiet.time.fire();
    await flush();
    expect(errors).toHaveLength(1);
  });
});
