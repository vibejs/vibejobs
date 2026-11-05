import type { JobDriver, JobRecord } from "./record.ts";

/** An in-process driver. Jobs disappear when the process stops. */
export function memoryDriver(): JobDriver {
  const jobs = new Map<string, JobRecord>();
  return {
    async setup() {},
    async put(job) {
      if (job.idempotencyKey !== undefined) {
        const existing = [...jobs.values()].find(
          (item) => item.idempotencyKey === job.idempotencyKey,
        );
        if (existing !== undefined) return existing;
      }
      const stored = { ...job };
      jobs.set(job.id, stored);
      return stored;
    },
    async claim(now) {
      const next = [...jobs.values()]
        .filter((job) => job.status === "pending" && job.runAt <= now)
        .sort((a, b) => a.runAt - b.runAt || a.id.localeCompare(b.id))[0];
      if (next === undefined) return undefined;
      const claimed = { ...next, status: "running" as const, attempts: next.attempts + 1 };
      jobs.set(next.id, claimed);
      return claimed;
    },
    async complete(id) {
      const job = jobs.get(id);
      if (job === undefined) return;
      jobs.set(id, { ...job, status: "done", lastError: undefined });
    },
    async reschedule(id, runAt, lastError) {
      const job = jobs.get(id);
      if (job === undefined) return;
      jobs.set(id, { ...job, status: "pending", runAt, lastError });
    },
    async dead(id, lastError) {
      const job = jobs.get(id);
      if (job === undefined) return;
      jobs.set(id, { ...job, status: "dead", lastError });
    },
  };
}
