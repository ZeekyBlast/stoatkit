import { setTimeout as delay } from "node:timers/promises";
import { StoatAPIError } from "./errors.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RestOptions {
  token: string;
  /** Default `https://api.stoat.chat`. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries for 5xx answers and network failures. Default 3. */
  maxRetries?: number;
}

export class Rest {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetries: number;

  constructor(options: RestOptions) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? "https://api.stoat.chat";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => delay(ms));
    this.#maxRetries = options.maxRetries ?? 3;
  }

  async request<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const route = `${method} ${path}`;
    const headers: Record<string, string> = { "X-Bot-Token": this.#token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(this.#baseUrl + path, init);
      } catch (err) {
        if (attempt >= this.#maxRetries) throw err;
        await this.#sleep(500 * 2 ** attempt);
        continue;
      }

      const parsed = await readBody(res);
      if (res.ok) return parsed as T;
      if (res.status >= 500 && attempt < this.#maxRetries) {
        await this.#sleep(500 * 2 ** attempt);
        continue;
      }
      throw toError(res.status, route, parsed);
    }
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
