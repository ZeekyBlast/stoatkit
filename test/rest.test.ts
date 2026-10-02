import { test } from "node:test";
import assert from "node:assert/strict";
import { Rest } from "../src/rest/rest.ts";
import { StoatAPIError } from "../src/rest/errors.ts";
import { queueFetch, json, fakeClock } from "./helpers/fetch.ts";

const TOKEN = "secret-bot-token";

function makeRest(queue: Array<Response | Error>) {
  const { fetch, calls } = queueFetch(queue);
  const clock = fakeClock();
  const rest = new Rest({ token: TOKEN, baseUrl: "https://api.test", fetch, sleep: clock.sleep });
  return { rest, calls, clock };
}

test("GET sends the bot token and returns parsed JSON", async () => {
  const { rest, calls } = makeRest([json(200, { _id: "U1", username: "vela" })]);
  assert.deepEqual(await rest.request("GET", "/users/@me"), { _id: "U1", username: "vela" });
  assert.equal(calls[0]!.url, "https://api.test/users/@me");
  assert.equal(calls[0]!.headers["x-bot-token"], TOKEN);
});

test("POST sends a JSON body", async () => {
  const { rest, calls } = makeRest([json(200, { _id: "M1" })]);
  await rest.request("POST", "/channels/C1/messages", { content: "hi" });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.headers["content-type"], "application/json");
  assert.deepEqual(calls[0]!.body, { content: "hi" });
});

test("204 No Content returns undefined", async () => {
  const { rest } = makeRest([new Response(null, { status: 204 })]);
  assert.equal(await rest.request("DELETE", "/channels/C1/messages/M1"), undefined);
});

test("a JSON error becomes a StoatAPIError and is not retried", async () => {
  const { rest, calls } = makeRest([json(403, { type: "MissingPermission", permission: "BanMembers" })]);
  await assert.rejects(rest.request("PUT", "/servers/S1/bans/U1", {}), (err: unknown) => {
    assert.ok(err instanceof StoatAPIError);
    assert.equal(err.status, 403);
    assert.equal(err.type, "MissingPermission");
    assert.equal(err.route, "PUT /servers/S1/bans/U1");
    assert.deepEqual(err.details, { type: "MissingPermission", permission: "BanMembers" });
    return true;
  });
  assert.equal(calls.length, 1);
});

test("a non-JSON error body still becomes a StoatAPIError", async () => {
  // Stoat answers a bad token with an HTML page, not JSON.
  const html = new Response("<!DOCTYPE html><h1>401: Unauthorized</h1>", {
    status: 401,
    headers: { "content-type": "text/html" },
  });
  const { rest } = makeRest([html]);
  await assert.rejects(rest.request("GET", "/users/@me"), (err: unknown) => {
    assert.ok(err instanceof StoatAPIError);
    assert.equal(err.type, "HTTP_401");
    return true;
  });
});

test("5xx is retried with growing waits", async () => {
  const { rest, calls, clock } = makeRest([json(502, {}), json(502, {}), json(200, { ok: true })]);
  assert.deepEqual(await rest.request("GET", "/"), { ok: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(clock.slept, [500, 1000]);
});

test("5xx gives up after 3 retries", async () => {
  const { rest, calls, clock } = makeRest([json(500, {}), json(500, {}), json(500, {}), json(500, {})]);
  await assert.rejects(rest.request("GET", "/"), (err: unknown) => err instanceof StoatAPIError && err.status === 500);
  assert.equal(calls.length, 4);
  assert.deepEqual(clock.slept, [500, 1000, 2000]);
});

test("a network failure is retried", async () => {
  const { rest, calls } = makeRest([new TypeError("fetch failed"), json(200, { ok: true })]);
  assert.deepEqual(await rest.request("GET", "/"), { ok: true });
  assert.equal(calls.length, 2);
});

test("the token never appears in an error", async () => {
  const { rest } = makeRest([json(404, { type: "NotFound" })]);
  await assert.rejects(rest.request("GET", "/users/U9"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes(TOKEN));
    assert.ok(!JSON.stringify(err).includes(TOKEN));
    return true;
  });
});

test("a retried POST reuses one Idempotency-Key so the message is not sent twice", async () => {
  const { rest, calls } = makeRest([json(502, {}), json(200, { _id: "M1" })]);
  await rest.request("POST", "/channels/C1/messages", { content: "hi" });
  const keys = calls.map((c) => c.headers["idempotency-key"]);
  assert.equal(keys.length, 2);
  assert.ok(keys[0], "POST carries an Idempotency-Key");
  assert.equal(keys[0], keys[1]);
});
