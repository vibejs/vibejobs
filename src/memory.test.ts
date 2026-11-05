import { expect, it } from "vitest";
import { memoryDriver } from "./memory.ts";
import type { JobRecord } from "./record.ts";

function pending(id: string, runAt: number, status: JobRecord["status"] = "pending"): JobRecord {
  return { id, name: "n", payload: { id }, attempts: 0, maxAttempts: 1, runAt, status };
}

it("claims the earliest pending job and ignores missing ids", async () => {
  const driver = memoryDriver();
  await driver.setup();
  await driver.complete("missing");
  await driver.reschedule("missing", 1, "x");
  await driver.dead("missing", "x");
  await driver.put(pending("b", 2));
  await driver.put(pending("a", 2));
  await driver.put(pending("z", 1));
  await driver.put(pending("c", 1, "done"));
  await driver.put(pending("d", 9));
  const again = await driver.put({ ...pending("e", 20), idempotencyKey: "same" });
  expect((await driver.put({ ...pending("f", 20), idempotencyKey: "same" })).id).toBe(again.id);
  expect((await driver.claim(2))?.id).toBe("z");
  expect((await driver.claim(2))?.id).toBe("a");
  expect((await driver.claim(2))?.id).toBe("b");
  expect(await driver.claim(2)).toBeUndefined();
  const late = await driver.claim(9);
  expect(late?.id).toBe("d");
  if (late === undefined) return;
  await driver.complete(late.id);
  await driver.reschedule("a", 3, "later");
  await driver.dead("b", "nope");
});
