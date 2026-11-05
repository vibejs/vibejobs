import { JOBS_INVALID_CRON, JobsError } from "./errors.ts";

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

type Field = (value: number) => boolean;

/** Five-field cron in UTC: minute hour day-of-month month day-of-week. All fields are required. */
export function cronMatches(expression: string, date: Date): boolean {
  const fields = parseCron(expression);
  return (
    fields[0](date.getUTCMinutes()) &&
    fields[1](date.getUTCHours()) &&
    fields[2](date.getUTCDate()) &&
    fields[3](date.getUTCMonth() + 1) &&
    fields[4](date.getUTCDay())
  );
}

export function parseCron(expression: string): readonly [Field, Field, Field, Field, Field] {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new JobsError(JOBS_INVALID_CRON, "A cron expression needs 5 fields.");
  }
  return [
    compile(parts[0], RANGES[0][0], RANGES[0][1]),
    compile(parts[1], RANGES[1][0], RANGES[1][1]),
    compile(parts[2], RANGES[2][0], RANGES[2][1]),
    compile(parts[3], RANGES[3][0], RANGES[3][1]),
    compile(parts[4], RANGES[4][0], RANGES[4][1]),
  ];
}

function compile(part: string, min: number, max: number): Field {
  const allowed = new Set<number>();
  for (const item of part.split(",")) addItem(allowed, item, min, max);
  return (value) => allowed.has(value);
}

function addItem(allowed: Set<number>, item: string, min: number, max: number): void {
  if (item === "*") {
    fill(allowed, min, max, 1);
    return;
  }
  const step = /^(\*|\d+-\d+|\d+)\/(\d+)$/.exec(item);
  if (step !== null) {
    const every = Number(step[2]);
    if (every < 1)
      throw new JobsError(JOBS_INVALID_CRON, `Cron step must be positive in "${item}".`);
    const [start, end] = bounds(step[1], min, max, item);
    fill(allowed, start, end, every);
    return;
  }
  const range = /^(\d+)-(\d+)$/.exec(item);
  if (range !== null) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    assertRange(start, end, min, max, item);
    fill(allowed, start, end, 1);
    return;
  }
  if (/^\d+$/.test(item)) {
    const value = Number(item);
    if (value < min || value > max) {
      throw new JobsError(JOBS_INVALID_CRON, `Cron value ${value} is outside ${min}-${max}.`);
    }
    allowed.add(value);
    return;
  }
  throw new JobsError(JOBS_INVALID_CRON, `Invalid cron field "${item}".`);
}

function bounds(spec: string, min: number, max: number, item: string): readonly [number, number] {
  if (spec === "*") return [min, max];
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range !== null) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    assertRange(start, end, min, max, item);
    return [start, end];
  }
  const start = Number(spec);
  if (start < min || start > max) {
    throw new JobsError(JOBS_INVALID_CRON, `Cron value ${start} is outside ${min}-${max}.`);
  }
  return [start, max];
}

function assertRange(start: number, end: number, min: number, max: number, item: string): void {
  if (start > end || start < min || end > max) {
    throw new JobsError(JOBS_INVALID_CRON, `Cron range "${item}" is outside ${min}-${max}.`);
  }
}

function fill(allowed: Set<number>, start: number, end: number, step: number): void {
  for (let value = start; value <= end; value += step) allowed.add(value);
}
