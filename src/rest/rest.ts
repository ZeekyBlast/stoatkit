import { setTimeout as delay } from "node:timers/promises";
import { RateLimitTimeout, StoatAPIError } from "./errors.ts";
import { routeKey } from "./routeKey.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RestOptions {
  token: string;
  /** Default `https://api.stoat.chat`. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Retries for 5xx answers and network failures. Default 3. 429s are counted separately. */
  maxRetries?: number;
  /** Throw `RateLimitTimeout` instead of waiting longer than this for a bucket. Default: wait as long as needed. */
  maxQueueWaitMs?: number;
}

/** Consecutive 429 answers tolerated before giving up with type "RateLimited". */
const MAX_RATE_LIMITED = 10;

type Bucket = { remaining: number; resetAt: number };

export class Rest {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #maxRetries: number;
  readonly #maxQueueWaitMs: number;
  readonly #buckets = new Map<string, Bucket>();
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: RestOptions) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? "https://api.stoat.chat";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => delay(ms));
    this.#now = options.now ?? Date.now;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#maxQueueWaitMs = options.maxQueueWaitMs ?? Infinity;
  }

  request<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    // ponytail: one request at a time per bucket; fine for a bot, revisit if throughput ever matters
    const key = routeKey(path);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.#send<T>(key, method, path, body));
    this.#queues.set(key, run);
    run
      .finally(() => {
        if (this.#queues.get(key) === run) this.#queues.delete(key);
      })
      .catch(() => {});
    return run;
  }

  async #send<T>(key: string, method: HttpMethod, path: string, body: unknown): Promise<T> {
    const route = `${method} ${path}`;
    const headers: Record<string, string> = { "X-Bot-Token": this.#token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    let failures = 0;
    let rateLimited = 0;
    for (;;) {
      await this.#waitForBucket(key);

      let res: Response;
      try {
        res = await this.#fetch(this.#baseUrl + path, init);
      } catch (err) {
        if (failures >= this.#maxRetries) throw err;
        await this.#sleep(500 * 2 ** failures++);
        continue;
      }

      this.#updateBucket(key, res.headers);
      const parsed = await readBody(res);
      if (res.ok) return parsed as T;

      if (res.status === 429) {
        if (++rateLimited > MAX_RATE_LIMITED) throw new StoatAPIError(429, "RateLimited", route, parsed);
        await this.#sleep(Number(res.headers.get("x-ratelimit-reset-after") ?? 1000));
        continue;
      }
      rateLimited = 0;

      if (res.status >= 500 && failures < this.#maxRetries) {
        await this.#sleep(500 * 2 ** failures++);
        continue;
      }
      throw toError(res.status, route, parsed);
    }
  }

  async #waitForBucket(key: string): Promise<void> {
    const bucket = this.#buckets.get(key);
    if (!bucket || bucket.remaining > 0) return;
    const wait = bucket.resetAt - this.#now();
    if (wait <= 0) return;
    if (wait > this.#maxQueueWaitMs) throw new RateLimitTimeout(key, wait);
    await this.#sleep(wait);
  }

  #updateBucket(key: string, headers: Headers): void {
    const remaining = headers.get("x-ratelimit-remaining");
    const resetAfter = headers.get("x-ratelimit-reset-after");
    if (remaining === null || resetAfter === null) return;
    this.#buckets.set(key, { remaining: Number(remaining), resetAt: this.#now() + Number(resetAfter) });
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 200);
  }
}

function toError(status: number, route: string, body: unknown): StoatAPIError {
  const type =
    typeof body === "object" && body !== null && typeof (body as { type?: unknown }).type === "string"
      ? (body as { type: string }).type
      : `HTTP_${status}`;
  return new StoatAPIError(status, type, route, body);
}
