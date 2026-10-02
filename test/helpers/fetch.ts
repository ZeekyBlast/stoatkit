export type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A fake fetch that answers from a queue, in order. An Error in the queue is thrown, like a network failure. */
export function queueFetch(queue: Array<Response | Error>) {
  const calls: FetchCall[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error("queueFetch: no response left in the queue");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

/** A JSON response with optional extra headers. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fake clock: sleep() moves time forward instantly and records every wait. */
export function fakeClock(start = 0) {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    slept,
  };
}

/** A fake fetch that answers by "METHOD /path". Unknown routes answer 404 NotFound. */
export function routeFetch(routes: Record<string, (body: unknown) => Response>) {
  const calls: FetchCall[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(input), method, headers: Object.fromEntries(new Headers(init.headers).entries()), body });
    const handler = routes[`${method} ${new URL(String(input)).pathname}`];
    return handler ? handler(body) : json(404, { type: "NotFound" });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}
