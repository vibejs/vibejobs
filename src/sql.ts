import { JOBS_QUERY_FAILED, JobsError } from "./errors.ts";
import type { JobDriver, JobRecord, JobStatus } from "./record.ts";

/** Runs one statement and returns its rows. Parameters use `$1` placeholders. */
export type QueryFn = (
  statement: string,
  params?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

const TABLE = `CREATE TABLE IF NOT EXISTS vibe_jobs (
  id text PRIMARY KEY,
  name text NOT NULL,
  payload text NOT NULL,
  idempotency_key text,
  attempts integer NOT NULL,
  max_attempts integer NOT NULL,
  run_at bigint NOT NULL,
  status text NOT NULL,
  last_error text
)`;

const INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS vibe_jobs_idempotency_key
  ON vibe_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL`;

const INSERT = `INSERT INTO vibe_jobs
  (id, name, payload, idempotency_key, attempts, max_attempts, run_at, status, last_error)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

const SELECT_KEY = `SELECT * FROM vibe_jobs WHERE idempotency_key = $1`;

const CLAIM = `UPDATE vibe_jobs
  SET status = 'running', attempts = attempts + 1
  WHERE id = (
    SELECT id FROM vibe_jobs
    WHERE status = 'pending' AND run_at <= $1
    ORDER BY run_at, id
    LIMIT 1
  )
  RETURNING *`;

/**
 * A SQL driver. `query` is supplied by the application, so this package does not import a database package.
 * Pass a function that runs the statement and returns rows.
 */
export function sqlDriver(query: QueryFn): JobDriver {
  let ready: Promise<void> | undefined;

  async function setup(): Promise<void> {
    if (ready === undefined) {
      ready = (async () => {
        await query(TABLE);
        await query(INDEX);
      })().catch((error: unknown) => {
        ready = undefined;
        throw new JobsError(JOBS_QUERY_FAILED, "Job storage setup failed.", { cause: error });
      });
    }
    await ready;
  }

  async function rows(
    statement: string,
    params: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]> {
    try {
      return await query(statement, params);
    } catch (error) {
      throw new JobsError(JOBS_QUERY_FAILED, "Job query failed.", { cause: error });
    }
  }

  return {
    setup,
    async put(job) {
      await setup();
      if (job.idempotencyKey !== undefined) {
        const found = (await rows(SELECT_KEY, [job.idempotencyKey]))[0];
        if (found !== undefined) return mapRow(found);
      }
      try {
        await query(INSERT, [
          job.id,
          job.name,
          JSON.stringify(job.payload),
          job.idempotencyKey ?? null,
          job.attempts,
          job.maxAttempts,
          job.runAt,
          job.status,
          job.lastError ?? null,
        ]);
      } catch (error) {
        if (job.idempotencyKey !== undefined && uniqueViolation(error)) {
          const found = (await rows(SELECT_KEY, [job.idempotencyKey]))[0];
          if (found !== undefined) return mapRow(found);
        }
        throw new JobsError(JOBS_QUERY_FAILED, "Job insert failed.", { cause: error });
      }
      return job;
    },
    async claim(now) {
      await setup();
      const found = (await rows(CLAIM, [now]))[0];
      if (found === undefined) return undefined;
      return mapRow(found);
    },
    async complete(id) {
      await setup();
      await rows(`UPDATE vibe_jobs SET status = 'done', last_error = NULL WHERE id = $1`, [id]);
    },
    async reschedule(id, runAt, lastError) {
      await setup();
      await rows(
        `UPDATE vibe_jobs SET status = 'pending', run_at = $2, last_error = $3 WHERE id = $1`,
        [id, runAt, lastError],
      );
    },
    async dead(id, lastError) {
      await setup();
      await rows(`UPDATE vibe_jobs SET status = 'dead', last_error = $2 WHERE id = $1`, [
        id,
        lastError,
      ]);
    },
  };
}

function uniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (Reflect.get(error, "code") === "23505") return true;
  return error instanceof Error && /duplicate key|unique constraint/i.test(error.message);
}

function mapRow(row: Record<string, unknown>): JobRecord {
  return {
    id: requiredString(row.id, "id"),
    name: requiredString(row.name, "name"),
    payload: parsePayload(row.payload),
    idempotencyKey: typeof row.idempotency_key === "string" ? row.idempotency_key : undefined,
    attempts: requiredNumber(row.attempts),
    maxAttempts: requiredNumber(row.max_attempts),
    runAt: requiredNumber(row.run_at),
    status: requiredStatus(row.status),
    lastError: typeof row.last_error === "string" ? row.last_error : undefined,
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new JobsError(JOBS_QUERY_FAILED, `Job row is missing ${label}.`);
  }
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
    return Number(value);
  throw new JobsError(JOBS_QUERY_FAILED, "Job row has a bad number.");
}

function requiredStatus(value: unknown): JobStatus {
  if (value === "pending" || value === "running" || value === "done" || value === "dead")
    return value;
  throw new JobsError(JOBS_QUERY_FAILED, "Job row has a bad status.");
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== "string") {
    throw new JobsError(JOBS_QUERY_FAILED, "Job payload is missing.");
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new JobsError(JOBS_QUERY_FAILED, "Job payload is not JSON.", { cause: error });
  }
}
