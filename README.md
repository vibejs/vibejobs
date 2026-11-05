# Vibe Jobs

**Background jobs for vibe.js. Memory and SQL drivers, retries, and cron.**

The package name is `@usevibejs/jobs`.

## Install

```bash
pnpm add @usevibejs/jobs @usevibejs/server
```

## Quick start

`enqueue`, a worker, an idempotency key, and retries. Drivers are memory and SQL. The SQL driver takes a query function. It does not import `@usevibejs/db`. Cron is tied to the server: it stops when the application shuts down. The job function stays in the application.

```ts
import { JobsModule, memoryDriver, sqlDriver } from "@usevibejs/jobs";

JobsModule.forRoot({ driver: memoryDriver() });
sqlDriver(async (statement, params = []) => {
  const result = await client.query(statement, [...params]);
  return result.rows;
});
```

## Error codes

See [docs/errors.md](docs/errors.md).

## Local development

```bash
pnpm install
pnpm check
```

`pnpm check` formats, lints, typechecks, and runs tests at 100% per-file coverage.

## Releases

Releases use changesets. A maintainer runs the Release workflow from main. Do not publish by hand.

## License

MIT. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
