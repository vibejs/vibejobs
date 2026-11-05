// oxlint-disable typescript/no-extraneous-class -- module classes are containers
import {
  Module,
  inject,
  token,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type Token,
} from "@usevibejs/server";
import { JOBS_INVALID, JobsError } from "./errors.ts";
import { Jobs, type JobsOptions } from "./jobs.ts";

/** Inject this to enqueue work and register handlers. */
export const JOBS: Token<Jobs> = token<Jobs>("JOBS");

class JobsRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly jobs = inject(JOBS);
  private stop = (): void => {};

  onApplicationBootstrap(): void {
    this.stop();
    this.stop = this.jobs.start();
  }

  onApplicationShutdown(): void {
    this.stop();
  }
}

/**
 * Runs the worker for the life of the server. Cron stops when the server stops.
 * The job body stays in the application.
 */
@Module({})
export class JobsModule {
  static forRoot(options: JobsOptions): DynamicModule {
    if (options.driver === undefined || typeof options.driver.put !== "function") {
      throw new JobsError(JOBS_INVALID, "A job driver is required.");
    }
    return {
      module: JobsModule,
      global: true,
      providers: [JobsRunner, { provide: JOBS, useValue: new Jobs(options) }],
      exports: [JOBS],
    };
  }
}
