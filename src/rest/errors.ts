/** A request Stoat answered with an error. `type` is Stoat's own error type, or `HTTP_<status>` when the body had none. */
export class StoatAPIError extends Error {
  readonly status: number;
  readonly type: string;
  readonly route: string;
  readonly details: unknown;

  constructor(status: number, type: string, route: string, details: unknown) {
    super(`${route} failed: ${status} ${type}`);
    this.name = "StoatAPIError";
    this.status = status;
    this.type = type;
    this.route = route;
    this.details = details;
  }
}

/** Thrown instead of waiting when a bucket's reset is further away than `maxQueueWaitMs`. */
export class RateLimitTimeout extends Error {
  readonly route: string;
  readonly waitMs: number;

  constructor(route: string, waitMs: number) {
    super(`Rate limit on ${route} would need a ${waitMs}ms wait`);
    this.name = "RateLimitTimeout";
    this.route = route;
    this.waitMs = waitMs;
  }
}
