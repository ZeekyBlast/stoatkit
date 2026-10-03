import { test } from "node:test";
import assert from "node:assert/strict";
import { Rest } from "../src/rest/rest.ts";
import { queueFetch } from "./helpers/fetch.ts";

function makeRest() {
  const { fetch, calls } = queueFetch([new Response(null, { status: 204 })]);
  const rest = new Rest({ token: "t", baseUrl: "https://api.test", fetch, sleep: async () => {} });
  return { rest, calls };
}

test("a reason is sent as X-Audit-Log-Reason", async () => {
  const { rest, calls } = makeRest();
  await rest.request("DELETE", "/servers/S1/members/U1", undefined, { reason: "spamming links" });
  assert.equal(calls[0]!.headers["x-audit-log-reason"], "spamming links");
});

test("no reason means no header", async () => {
  const { rest, calls } = makeRest();
  await rest.request("DELETE", "/servers/S1/members/U1");
  assert.equal(calls[0]!.headers["x-audit-log-reason"], undefined);
});

test("a reason with accents, dashes, emoji or newlines still sends, made header-safe", async () => {
  const { rest, calls } = makeRest();
  await rest.request("DELETE", "/servers/S1/members/U1", undefined, { reason: "café spam — 🚫\nlinks" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.headers["x-audit-log-reason"], "cafe spam ? ? links");
});

test("a reason longer than Stoat's 512 limit is cut", async () => {
  const { rest, calls } = makeRest();
  await rest.request("DELETE", "/servers/S1/members/U1", undefined, { reason: "x".repeat(600) });
  assert.equal(calls[0]!.headers["x-audit-log-reason"]!.length, 512);
});
