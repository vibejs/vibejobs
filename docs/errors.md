# Error codes

These codes belong to `@usevibejs/jobs`. The `VIBE` series belongs to the vibe.js monorepo and is not used here.

| Code                   | Meaning                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `JOBS_INVALID`         | Thrown for a bad name, driver, interval, delay, or attempt count.            |
| `JOBS_INVALID_CRON`    | Thrown when a cron expression is not five UTC fields.                        |
| `JOBS_INVALID_PAYLOAD` | Thrown when a payload is not JSON.                                           |
| `JOBS_HANDLER_MISSING` | Stored on a job whose handler was not registered. The body stays in the app. |
| `JOBS_QUERY_FAILED`    | Thrown when the SQL query function fails or a row cannot be read.            |
