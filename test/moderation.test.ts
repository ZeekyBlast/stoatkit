import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { StoatAPIError } from "../src/rest/errors.ts";
import { json } from "./helpers/fetch.ts";
import { connected, destroyClients, id, msg, CHANNEL, READY, SERVER, USER } from "./helpers/client.ts";

afterEach(destroyClients);

const TARGET = id(90);
const DM = id(91);
const MEMBER_PATH = `/servers/${SERVER}/members/${TARGET}`;
const raw = (extra: object = {}) => ({ _id: { server: SERVER, user: TARGET }, joined_at: "2026-10-01T00:00:00.000Z", ...extra });

const MOD_READY = {
  ...READY,
  servers: [{ _id: SERVER, owner: USER, name: "S", channels: [CHANNEL], default_permissions: 0, approximate_member_count: 2 }],
};

const noContent = () => new Response(null, { status: 204 });

/** A client where TARGET is a cached member. */
async function withTarget(routes: Record<string, (body: unknown) => Response>) {
  const ctx = await connected({ ready: MOD_READY, routes });
  ctx.socket.receive({ ...msg(10, "hi", TARGET), member: raw() });
  const target = ctx.client.members.get(SERVER, TARGET)!;
  const sent = () => ctx.calls.filter((c) => new URL(c.url).pathname !== "/" && !c.url.endsWith("/users/@me"));
  return { ...ctx, target, sent };
}

test("timeout sets an end time and passes the reason", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-02T12:00:00.000Z") });
  const { target, sent } = await withTarget({
    [`PATCH ${MEMBER_PATH}`]: () => json(200, raw({ timeout: "2026-10-02T12:10:00.000Z" })),
  });
  const after = await target.timeout(600_000, "spam");
  const [call] = sent();
  assert.equal(call!.method, "PATCH");
  assert.deepEqual(call!.body, { timeout: "2026-10-02T12:10:00.000Z" });
  assert.equal(call!.headers["x-audit-log-reason"], "spam");
  assert.equal(after.timeoutUntil?.toISOString(), "2026-10-02T12:10:00.000Z");
});

test("untimeout removes the timeout field", async () => {
  const { target, sent } = await withTarget({ [`PATCH ${MEMBER_PATH}`]: () => json(200, raw()) });
  const after = await target.untimeout();
  assert.deepEqual(sent()[0]!.body, { remove: ["Timeout"] });
  assert.equal(sent()[0]!.headers["x-audit-log-reason"], undefined);
  assert.equal(after.timeoutUntil, null);
});

test("kick sends DELETE with a header-safe reason", async () => {
  const { target, sent } = await withTarget({ [`DELETE ${MEMBER_PATH}`]: noContent });
  await target.kick("raid — 🚫");
  assert.equal(sent()[0]!.method, "DELETE");
  assert.equal(sent()[0]!.headers["x-audit-log-reason"], "raid ? ?");
});

test("ban keeps the full reason in the body and sends no header", async () => {
  const { target, sent } = await withTarget({
    [`PUT /servers/${SERVER}/bans/${TARGET}`]: () => json(200, { _id: { server: SERVER, user: TARGET }, reason: "raid — 🚫" }),
  });
  await target.ban({ reason: "raid — 🚫", deleteMessageSeconds: 3600 });
  assert.deepEqual(sent()[0]!.body, { reason: "raid — 🚫", delete_message_seconds: 3600 });
  assert.equal(sent()[0]!.headers["x-audit-log-reason"], undefined);
});

test("server.ban works by id for users who already left; unban removes it", async () => {
  const { client, sent } = await withTarget({
    [`PUT /servers/${SERVER}/bans/${id(92)}`]: () => json(200, { _id: { server: SERVER, user: id(92) } }),
    [`DELETE /servers/${SERVER}/bans/${id(92)}`]: noContent,
  });
  const server = client.servers.get(SERVER)!;
  await server.ban(id(92));
  await server.unban(id(92), "appeal accepted");
  assert.deepEqual(sent().map((c) => c.method), ["PUT", "DELETE"]);
  assert.deepEqual(sent()[0]!.body, {});
  assert.equal(sent()[1]!.headers["x-audit-log-reason"], "appeal accepted");
});

test("setSlowmode sets seconds, and 0 removes it", async () => {
  const { client, sent } = await withTarget({
    [`PATCH /channels/${CHANNEL}`]: (body) =>
      json(200, { _id: CHANNEL, channel_type: "TextChannel", name: "general", server: SERVER, ...(body as object) }),
  });
  const channel = client.channels.get(CHANNEL)!;
  const slowed = await channel.setSlowmode(10, "heat");
  assert.equal(slowed.slowmode, 10);
  await channel.setSlowmode(0);
  assert.deepEqual(sent().map((c) => c.body), [{ slowmode: 10 }, { remove: ["Slowmode"] }]);
  assert.equal(sent()[0]!.headers["x-audit-log-reason"], "heat");
});

test("bulkDelete sends the ids", async () => {
  const { client, sent } = await withTarget({ [`DELETE /channels/${CHANNEL}/messages/bulk`]: noContent });
  await client.channels.get(CHANNEL)!.bulkDelete([id(10), id(11)], "raid cleanup");
  assert.deepEqual(sent()[0]!.body, { ids: [id(10), id(11)] });
});

test("user.dm opens a DM channel and caches it", async () => {
  const { client } = await withTarget({
    [`GET /users/${USER}/dm`]: () => json(200, { _id: DM, channel_type: "DirectMessage", active: true, recipients: [USER] }),
  });
  const channel = await client.users.get(USER)!.dm();
  assert.equal(channel.id, DM);
  assert.equal(channel.type, "DirectMessage");
  assert.equal(client.channels.get(DM), channel);
});

test("a refused action throws StoatAPIError with Stoat's reason", async () => {
  const { target } = await withTarget({
    [`DELETE ${MEMBER_PATH}`]: () => json(403, { type: "NotElevated" }),
  });
  await assert.rejects(target.kick(), (e: unknown) => e instanceof StoatAPIError && e.type === "NotElevated");
});

test("a ban reason over Stoat's 1024 limit is cut, so the ban still happens", async () => {
  const { target, sent } = await withTarget({
    [`PUT /servers/${SERVER}/bans/${TARGET}`]: () => json(200, { _id: { server: SERVER, user: TARGET } }),
  });
  await target.ban({ reason: "x".repeat(1500) });
  assert.equal((sent()[0]!.body as { reason: string }).reason.length, 1024);
});
