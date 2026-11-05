import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import { cronMatches, parseCron } from "./cron.ts";
import { JOBS_HANDLER_MISSING, JOBS_INVALID, JOBS_INVALID_PAYLOAD, JobsError } from "./errors.ts";
import {
  retryDelay,
  type EnqueueOptions,
  type JobDriver,
  type JobHandler,
  type JobRecord,
} from "./record.ts";

export interface JobsOptions {
  readonly driver: JobDriver;
  readonly clock?: Clock;
  /** How often the worker looks for due work. Default 1000. */
  readonly intervalMs?: number;
  /** Base retry delay in milliseconds. Default 50. */
  readonly baseDelayMs?: number;
  readonly onError?: (error: unknown) => void;
}

interface CronJob {
  readonly expression: string;
  readonly name: string;
  readonly payload: unknown;
  lastMinute?: string;
}

/**
 * Enqueues work and runs it while the caller keeps the timer alive.
 * The job body stays in the application: register it with `handle`.
 */
export class Jobs {
  private readonly driver: JobDriver;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly baseDelayMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly crons: CronJob[] = [];
  private working = false;

  constructor(options: JobsOptions) {
    const intervalMs = options.intervalMs ?? 1000;
    const baseDelayMs = options.baseDelayMs ?? 50;
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new JobsError(JOBS_INVALID, "intervalMs must be a positive integer.");
    }
    if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0) {
      throw new JobsError(JOBS_INVALID, "baseDelayMs must be a non-negative integer.");
    }
    this.driver = options.driver;
    this.clock = options.clock ?? systemClock();
    this.intervalMs = intervalMs;
    this.baseDelayMs = baseDelayMs;
    this.onError = options.onError ?? (() => {});
  }

  handle(name: string, handler: JobHandler): void {
    if (name.trim() === "") throw new JobsError(JOBS_INVALID, "Job name is required.");
    this.handlers.set(name, handler);
  }

  async enqueue(
    name: string,
    payload: unknown,
    options: EnqueueOptions = {},
  ): Promise<{ id: string }> {
    if (name.trim() === "") throw new JobsError(JOBS_INVALID, "Job name is required.");
    if (options.idempotencyKey !== undefined && options.idempotencyKey.trim() === "") {
      throw new JobsError(JOBS_INVALID, "Idempotency key must not be empty.");
    }
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new JobsError(JOBS_INVALID, "maxAttempts must be a positive integer.");
    }
    const runAt = options.runAt ?? this.clock.now();
    if (!Number.isFinite(runAt))
      throw new JobsError(JOBS_INVALID, "runAt must be a finite number.");
    const job = await this.driver.put({
      id: randomUUID(),
      name,
      payload: jsonPayload(payload),
      idempotencyKey: options.idempotencyKey,
      attempts: 0,
      maxAttempts,
      runAt,
      status: "pending",
    });
    return { id: job.id };
  }

  /** Enqueues `name` while this process is alive, on the minutes `expression` matches. */
  schedule(expression: string, name: string, payload: unknown): void {
    if (name.trim() === "") throw new JobsError(JOBS_INVALID, "Job name is required.");
    parseCron(expression);
    this.crons.push({ expression, name, payload });
  }

  /** Starts the worker. The returned function stops it. Cron does not survive the caller's lifetime. */
  start(): () => void {
    return this.clock.every(this.intervalMs, () => {
      void this.tick().catch((error: unknown) => {
        this.onError(error);
      });
    });
  }

  async tick(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      await this.enqueueDueCrons();
      for (;;) {
        const ran = await this.runOne();
        if (!ran) break;
      }
    } finally {
      this.working = false;
    }
  }

  private async enqueueDueCrons(): Promise<void> {
    const now = new Date(this.clock.now());
    const minute = now.toISOString().slice(0, 16);
    for (const cron of this.crons) {
      if (cron.lastMinute === minute) continue;
      if (!cronMatches(cron.expression, now)) continue;
      await this.enqueue(cron.name, cron.payload, {
        idempotencyKey: `cron:${cron.name}:${minute}`,
      });
      cron.lastMinute = minute;
    }
  }

  private async runOne(): Promise<boolean> {
    const job = await this.driver.claim(this.clock.now());
    if (job === undefined) return false;
    const handler = this.handlers.get(job.name);
    if (handler === undefined) {
      await this.fail(job, JOBS_HANDLER_MISSING);
      return true;
    }
    try {
      await handler(job.payload);
      await this.driver.complete(job.id);
    } catch (error) {
      await this.fail(job, error instanceof Error ? error.message : "Job failed.");
    }
    return true;
  }

  private async fail(job: JobRecord, message: string): Promise<void> {
    if (job.attempts >= job.maxAttempts) {
      await this.driver.dead(job.id, message);
      return;
    }
    await this.driver.reschedule(
      job.id,
      this.clock.now() + retryDelay(job.attempts, this.baseDelayMs),
      message,
    );
  }
}

function jsonPayload(payload: unknown): unknown {
  try {
    const encoded = JSON.stringify(payload);
    if (typeof encoded !== "string") {
      throw new JobsError(JOBS_INVALID_PAYLOAD, "Job payload must be JSON.");
    }
    return JSON.parse(encoded);
  } catch (error) {
    if (error instanceof JobsError) throw error;
    throw new JobsError(JOBS_INVALID_PAYLOAD, "Job payload must be JSON.", { cause: error });
  }
}
