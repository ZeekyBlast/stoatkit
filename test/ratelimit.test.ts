import { test } from "node:test";
import assert from "node:assert/strict";
import { Rest } from "../src/rest/rest.ts";
import { StoatAPIError, RateLimitTimeout } from "../src/rest/errors.ts";
import { queueFetch, json, fakeClock } from "./helpers/fetch.ts";

const limited = (remaining: number, resetAfterMs: number) => ({
  "x-ratelimit-bucket": "b1",
  "x-ratelimit-limit": "5",
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset-after": String(resetAfterMs),
});

function makeRest(queue: Array<Response | Error>, extra: { maxQueueWaitMs?: number } = {}) {
  const { fetch, calls } = queueFetch(queue);
  const clock = fakeClock();
  const rest = new Rest({ token: "t", baseUrl: "https://api.test", fetch, sleep: clock.sleep, now: clock.now, ...extra });
  return { rest, calls, clock };
}

test("waits for the reset when a bucket is empty", async () => {
  const { rest, clock } = makeRest([json(200, {}, limited(0, 4000)), json(200, {}, limited(4, 10000))]);
  await rest.request("PUT", "/servers/S1/bans/U1", {});
  await rest.request("PUT", "/servers/S1/bans/U2", {});
  assert.deepEqual(clock.slept, [4000]);
});

test("all /servers/:id routes share one bucket", async () => {
  const { rest, clock } = makeRest([json(200, {}, limited(0, 3000)), json(200, {}, limited(4, 10000))]);
  await rest.request("PUT", "/servers/S1/bans/U1", {});
  await rest.request("PATCH", "/servers/S1/members/U2", {});
  assert.deepEqual(clock.slept, [3000]);
});

test("different resources do not wait on each other", async () => {
  const { rest, clock } = makeRest([json(200, {}, limited(0, 5000)), json(200, {}, limited(9, 10000))]);
  await rest.request("PUT", "/servers/S1/bans/U1", {});
  await rest.request("POST", "/channels/C1/messages", { content: "x" });
  assert.deepEqual(clock.slept, []);
});

test("a reset that already passed causes no wait", async () => {
  const { rest, clock } = makeRest([json(200, {}, limited(0, 1000)), json(200, {}, limited(4, 10000))]);
  await rest.request("GET", "/servers/S1");
  clock.advance(1500);
  await rest.request("GET", "/servers/S1");
  assert.deepEqual(clock.slept, []);
});

test("429 waits for reset-after and retries", async () => {
  const { rest, calls, clock } = makeRest([json(429, {}, limited(0, 2500)), json(200, { ok: true }, limited(4, 10000))]);
  assert.deepEqual(await rest.request("GET", "/servers/S1"), { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(clock.slept, [2500]);
});

test("429s do not use up the 5xx retries", async () => {
  // maxRetries defaults to 3, so four 429s followed by a 200 must still succeed.
  const { rest } = makeRest([
    json(429, {}, limited(0, 100)),
    json(429, {}, limited(0, 100)),
    json(429, {}, limited(0, 100)),
    json(429, {}, limited(0, 100)),
    json(200, { ok: true }, limited(4, 10000)),
  ]);
  assert.deepEqual(await rest.request("GET", "/servers/S1"), { ok: true });
});

test("gives up after 10 rate-limited answers in a row", async () => {
  const queue = Array.from({ length: 11 }, () => json(429, {}, limited(0, 100)));
  const { rest, calls } = makeRest(queue);
  await assert.rejects(
    rest.request("GET", "/servers/S1"),
    (err: unknown) => err instanceof StoatAPIError && err.type === "RateLimited",
  );
  assert.equal(calls.length, 11);
});

test("maxQueueWaitMs turns a long wait into RateLimitTimeout", async () => {
  const { rest, calls } = makeRest([json(200, {}, limited(0, 4000))], { maxQueueWaitMs: 1000 });
  await rest.request("PUT", "/servers/S1/bans/U1", {});
  await assert.rejects(rest.request("PUT", "/servers/S1/bans/U2", {}), (err: unknown) => {
    assert.ok(err instanceof RateLimitTimeout);
    assert.equal(err.route, "servers/S1");
    assert.equal(err.waitMs, 4000);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("concurrent requests on one bucket wait for each other's limits", async () => {
  const { rest, clock } = makeRest([
    json(200, {}, limited(0, 1000)),
    json(200, {}, limited(0, 1000)),
    json(200, {}, limited(4, 10000)),
  ]);
  await Promise.all([
    rest.request("PUT", "/servers/S1/bans/A", {}),
    rest.request("PUT", "/servers/S1/bans/B", {}),
    rest.request("PUT", "/servers/S1/bans/C", {}),
  ]);
  assert.deepEqual(clock.slept, [1000, 1000]);
});
