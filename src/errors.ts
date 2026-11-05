/** Stable codes owned by `@usevibejs/jobs`. They are not vibe.js `VIBE` codes. */
export const JOBS_INVALID = "JOBS_INVALID";
export const JOBS_INVALID_CRON = "JOBS_INVALID_CRON";
export const JOBS_INVALID_PAYLOAD = "JOBS_INVALID_PAYLOAD";
export const JOBS_HANDLER_MISSING = "JOBS_HANDLER_MISSING";
export const JOBS_QUERY_FAILED = "JOBS_QUERY_FAILED";

/** A jobs error. `code` is stable. */
export class JobsError extends Error {
  override readonly name = "JobsError";
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
