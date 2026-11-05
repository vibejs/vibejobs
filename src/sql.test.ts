import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { JOBS_QUERY_FAILED } from "./errors.ts";
import { Jobs } from "./jobs.ts";
import type { JobRecord } from "./record.ts";
import { sqlDriver, type QueryFn } from "./sql.ts";

const base: JobRecord = {
  id: "job-1",
  name: "send",
  payload: { n: 1 },
  attempts: 0,
  maxAttempts: 3,
  runAt: 10,
  status: "pending",
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    name: "send",
    payload: '{"n":1}',
    idempotency_key: "k",
    attempts: "2",
    max_attempts: 3,
    run_at: "10",
    status: "pending",
    last_error: "boom",
    ...overrides,
  };
}

it("stores, deduplicates, retries, and finishes jobs in Postgres", async () => {
  const client = new PGlite();
  const query: QueryFn = async (statement, params = []) => {
    const result = await client.query<Record<string, unknown>>(statement, [...params]);
    return result.rows;
  };
  const jobs = new Jobs({
    driver: sqlDriver(query),
    clock: { now: () => 1_700_000_000_000, every: () => () => {} },
    baseDelayMs: 0,
    intervalMs: 10,
  });
  let fails = 0;
  jobs.handle("send", () => {
    fails += 1;
    if (fails === 1) throw new Error("later");
  });
  const first = await jobs.enqueue("send", { n: 1 }, { idempotencyKey: "once", maxAttempts: 2 });
  expect((await jobs.enqueue("send", { n: 2 }, { idempotencyKey: "once" })).id).toBe(first.id);
  await jobs.tick();
  expect(fails).toBe(2);
  jobs.handle("once", () => {
    throw new Error("stop");
  });
  await jobs.enqueue("once", { n: 3 }, { maxAttempts: 1 });
  await jobs.tick();
  const stored = await client.query<{ status: string }>(`select status from vibe_jobs`);
  expect(stored.rows.map((item) => item.status).sort()).toEqual(["dead", "done"]);
  await client.close();
});

it("maps driver failures and bad rows", async () => {
  let mode = "setup-fail";
  let claimRow = row();
  const inserted: unknown[][] = [];
  const query: QueryFn = async (statement, params) => {
    if (mode === "setup-fail" || mode === "query-fail") throw new Error("offline");
    if (statement.startsWith("CREATE")) return [];
    if (statement.startsWith("SELECT")) {
      if (mode === "existing" || mode === "recover") return [row()];
      return [];
    }
    if (statement.startsWith("INSERT")) {
      if (mode === "duplicate-code" || mode === "duplicate-message" || mode === "duplicate-miss") {
        const current = mode;
        if (current !== "duplicate-miss") mode = "recover";
        if (current === "duplicate-message") throw new Error("unique constraint vibe_jobs");
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      if (mode === "insert-string") throw "nope";
      if (mode === "insert-null") throw null;
      if (mode === "insert-object") throw { code: "999" };
      if (mode === "insert-error") throw new Error("connection lost");
      inserted.push([...(params ?? [])]);
      return [];
    }
    if (statement.includes("RETURNING")) return mode === "claim" ? [claimRow] : [];
    return [];
  };
  const driver = sqlDriver(query);
  await expect(driver.setup()).rejects.toMatchObject({ code: JOBS_QUERY_FAILED });
  mode = "ok";
  await driver.setup();
  await driver.setup();
  mode = "with-key";
  expect((await driver.put({ ...base, idempotencyKey: "k" })).id).toBe("job-1");
  expect(inserted[0]?.[3]).toBe("k");
  expect(inserted[0]?.[8]).toBeNull();
  mode = "existing";
  expect((await driver.put({ ...base, id: "other", idempotencyKey: "k" })).status).toBe("pending");
  mode = "duplicate-code";
  expect((await driver.put({ ...base, idempotencyKey: "k" })).idempotencyKey).toBe("k");
  mode = "duplicate-message";
  expect((await driver.put({ ...base, idempotencyKey: "k" })).name).toBe("send");
  mode = "duplicate-miss";
  await expect(driver.put({ ...base, idempotencyKey: "k" })).rejects.toMatchObject({
    code: JOBS_QUERY_FAILED,
  });
  mode = "insert-error";
  await expect(driver.put({ ...base, idempotencyKey: "k" })).rejects.toMatchObject({
    code: JOBS_QUERY_FAILED,
  });
  mode = "insert-error";
  await expect(driver.put(base)).rejects.toMatchObject({ code: JOBS_QUERY_FAILED });
  for (const failing of ["insert-string", "insert-null", "insert-object"] as const) {
    mode = failing;
    await expect(driver.put({ ...base, idempotencyKey: "k" })).rejects.toMatchObject({
      code: JOBS_QUERY_FAILED,
    });
  }
  mode = "with-error";
  await driver.put({ ...base, lastError: "boom" });
  expect(inserted.at(-1)?.[8]).toBe("boom");
  mode = "ok";
  await driver.put(base);
  expect(inserted.at(-1)?.[3]).toBeNull();
  mode = "query-fail";
  await expect(driver.claim(10)).rejects.toMatchObject({ code: JOBS_QUERY_FAILED });
  mode = "claim";
  for (const status of ["pending", "running", "done", "dead"] as const) {
    claimRow = row({ status });
    expect((await driver.claim(10))?.status).toBe(status);
  }
  claimRow = row({ attempts: 4, idempotency_key: null, last_error: null, status: "running" });
  const mapped = await driver.claim(10);
  expect(mapped?.attempts).toBe(4);
  expect(mapped?.idempotencyKey).toBeUndefined();
  expect(mapped?.lastError).toBeUndefined();
  claimRow = row({ attempts: "nope" });
  await expect(driver.claim(10)).rejects.toMatchObject({ code: JOBS_QUERY_FAILED });
  claimRow = row({ attempts: Number.POSITIVE_INFINITY });
  await expect(driver.claim(10)).rejects.toMatchObject({ code: JOBS_QUERY_FAILED });
  for (const bad of [
    row({ attempts: "  " }),
    row({ id: "" }),
    row({ payload: "{" }),
    row({ payload: 1 }),
    row({ status: "nope" }),
    row({ name: 1 }),
  ]) {
    claimRow = bad;
    await expect(driver.claim(10)).rejects.toMatchObject({ code: JOBS_QUERY_FAILED });
  }
  mode = "ok";
  expect(await driver.claim(10)).toBeUndefined();
  await driver.complete("missing");
  await driver.reschedule("missing", 1, "x");
  await driver.dead("missing", "x");
});
