/** The clock the worker and cron use. Tests pass a manual clock. */
export interface Clock {
  now(): number;
  every(ms: number, fn: () => void): () => void;
}

/** `Date.now` and `setInterval`. The interval stops when the returned function runs. */
export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    every(ms, fn) {
      const timer = setInterval(fn, ms);
      return () => {
        clearInterval(timer);
      };
    },
  };
}
