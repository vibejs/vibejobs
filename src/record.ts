export type JobStatus = "pending" | "running" | "done" | "dead";

export interface JobRecord {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
  readonly idempotencyKey?: string;
  attempts: number;
  readonly maxAttempts: number;
  runAt: number;
  status: JobStatus;
  lastError?: string;
}

export interface JobDriver {
  setup(): Promise<void>;
  put(job: JobRecord): Promise<JobRecord>;
  claim(now: number): Promise<JobRecord | undefined>;
  complete(id: string): Promise<void>;
  reschedule(id: string, runAt: number, lastError: string): Promise<void>;
  dead(id: string, lastError: string): Promise<void>;
}

export interface EnqueueOptions {
  readonly idempotencyKey?: string;
  readonly runAt?: number;
  readonly maxAttempts?: number;
}

export type JobHandler = (payload: unknown) => void | Promise<void>;

/** Delay before attempt `attempt` (1-based) runs again. The delay caps at 8 doublings. */
export function retryDelay(attempt: number, baseMs: number): number {
  const power = Math.min(Math.max(attempt, 1), 8);
  return baseMs * 2 ** (power - 1);
}
