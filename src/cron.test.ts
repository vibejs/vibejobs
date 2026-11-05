import { describe, expect, it } from "vitest";
import { cronMatches, parseCron } from "./cron.ts";
import { JOBS_INVALID_CRON } from "./errors.ts";

const at = new Date(Date.UTC(2024, 0, 1, 8, 30));

describe("cronMatches", () => {
  it("matches every UTC field and stops at the first miss", () => {
    expect(cronMatches("30 8 1 1 1", at)).toBe(true);
    expect(cronMatches("0 8 1 1 1", at)).toBe(false);
    expect(cronMatches("30 0 1 1 1", at)).toBe(false);
    expect(cronMatches("30 8 2 1 1", at)).toBe(false);
    expect(cronMatches("30 8 1 2 1", at)).toBe(false);
    expect(cronMatches("30 8 1 1 0", at)).toBe(false);
    expect(cronMatches("  *   * * * *  ", at)).toBe(true);
  });
});

describe("parseCron", () => {
  it("accepts stars, lists, ranges, and steps", () => {
    expect(cronMatches("*/15 * * * *", at)).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date(Date.UTC(2024, 0, 1, 8, 6)))).toBe(false);
    expect(cronMatches("5/2 * * * *", new Date(Date.UTC(2024, 0, 1, 8, 7)))).toBe(true);
    expect(cronMatches("1-10/3 * * * *", new Date(Date.UTC(2024, 0, 1, 8, 4)))).toBe(true);
    expect(cronMatches("* 1-3,10 * * *", new Date(Date.UTC(2024, 0, 1, 2, 0)))).toBe(true);
    expect(parseCron("* * * * *")).toHaveLength(5);
  });

  it("rejects a field that is not a cron field", () => {
    const bad = [
      "* * *",
      "* * * * * *",
      "60 * * * *",
      "* * 0 * *",
      "1-60 * * * *",
      "10-1 * * * *",
      "*/0 * * * *",
      "nope * * * *",
      "1,,2 * * * *",
      "70/2 * * * *",
      "10-1/2 * * * *",
      "* * 0-2 * *",
      "* * 1-32 * *",
    ];
    for (const expression of bad) {
      expect(() => parseCron(expression)).toThrow(
        expect.objectContaining({ code: JOBS_INVALID_CRON }),
      );
    }
  });
});
