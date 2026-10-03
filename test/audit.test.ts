import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AuditLogEntry } from "../src/client.ts";
import { json } from "./helpers/fetch.ts";
import { waitFor } from "./helpers/wait.ts";
import { connected, destroyClients, id, idAt, BOT, CHANNEL, READY, SERVER, USER } from "./helpers/client.ts";

afterEach(destroyClients);

const MOD = id(100);
const TARGET = id(101);
const ROLE = id(102);
const AUDIT_PATH = `GET /servers/${SERVER}/audit_logs`;
const VIEW_AUDIT_LOGS = 2 ** 40;

/** The bot's role decides whether it may read the audit log. */
function readyWith(botPermissions: number) {
  return {
    ...READY,
    servers: [
      {
        _id: SERVER,
        owner: USER,
        name: "S",
        channels: [CHANNEL],
        default_permissions: 0,
        approximate_member_count: 3,
        roles: { [ROLE]: { _id: ROLE, name: "Bot", permissions: { a: botPermissions, d: 0 }, rank: 0 } },
      },
    ],
    members: [{ _id: { server: SERVER, user: BOT }, joined_at: "2026-10-01T00:00:00.000Z", roles: [ROLE] }],
  };
}

const entry = (action: object, extra: object = {}) => ({
  _id: idAt(Date.now(), 1),
  server: SERVER,
  user: MOD,
  reason: "raiding",
  action,
  ...extra,
});
const page = (...entries: object[]) => ({ audit_logs: entries, users: [{ _id: MOD, username: "moddy", discriminator: "0004" }], members: [] });

async function lookup(answers: object[], options: { botPermissions?: number; auditLookup?: boolean } = {}) {
  const pages = [...answers];
  const ctx = await connected({
    ready: readyWith(options.botPermissions ?? VIEW_AUDIT_LOGS),
    routes: { [AUDIT_PATH]: () => json(200, pages.shift() ?? page()) },
    options: { auditDelaysMs: [0, 0], auditLookup: options.auditLookup ?? true },
  });
  const found: AuditLogEntry[] = [];
  ctx.client.on("auditLogEntry", (e) => found.push(e));
  const auditCalls = () => ctx.calls.filter((c) => c.url.includes("/audit_logs"));
  return { ...ctx, found, auditCalls };
}

test("a kick finds who did it and why", async () => {
  const { socket, found, auditCalls, client } = await lookup([page(entry({ type: "MemberKick", user: TARGET }))]);
  socket.receive({ type: "ServerMemberLeave", id: SERVER, user: TARGET, reason: "Kick" });
  await waitFor(() => found.length === 1);
  assert.deepEqual(found[0], { serverId: SERVER, action: "MemberKick", targetId: TARGET, executorId: MOD, reason: "raiding" });
  assert.equal(new URL(auditCalls()[0]!.url).search, "?type=MemberKick&limit=10");
  assert.equal(client.users.get(MOD)?.username, "moddy");
});

test("a ban looks for BanCreate", async () => {
  const { socket, found } = await lookup([page(entry({ type: "BanCreate", user: TARGET }))]);
  socket.receive({ type: "ServerMemberLeave", id: SERVER, user: TARGET, reason: "Ban" });
  await waitFor(() => found.length === 1);
  assert.equal(found[0]!.action, "BanCreate");
  assert.equal(found[0]!.executorId, MOD);
});

test("an entry that isn't written yet is found on the retry", async () => {
  const { socket, found, auditCalls } = await lookup([page(), page(entry({ type: "MemberKick", user: TARGET }))]);
  socket.receive({ type: "ServerMemberLeave", id: SERVER, user: TARGET, reason: "Kick" });
  await waitFor(() => found.length === 1);
  assert.equal(auditCalls().length, 2);
  assert.equal(found[0]!.executorId, MOD);
});

test("an old entry for the same user is not blamed", async () => {
  const old = entry({ type: "MemberKick", user: TARGET }, { _id: idAt(Date.now() - 5 * 60_000, 2), user: id(103) });
  const { socket, found, auditCalls } = await lookup([page(old), page(old)]);
  socket.receive({ type: "ServerMemberLeave", id: SERVER, user: TARGET, reason: "Kick" });
  await waitFor(() => found.length === 1);
  assert.equal(auditCalls().length, 2);
  assert.equal(found[0]!.executorId, null);
});

test("an entry about someone else is not blamed", async () => {
  const { socket, found } = await lookup([page(entry({ type: "MemberKick", user: id(104) })), page()]);
  socket.receive({ type: "ServerMemberLeave", id: SERVER, user: TARGET, reason: "Kick" });
  await waitFor(() => found.length === 1);
  assert.equal(found[0]!.executorId, null);
});

test("without ViewAuditLogs nothing is fetched, and the event says unknown", async () => {
  const { socket, found, auditCalls } = await lookup([], { botPermissions: 64 });
  socket.receive({ type: "ServerMemberLeave", id: SERVER, user: TARGET, reason: "Kick" });
  await waitFor(() => found.length === 1);
  assert.equal(auditCalls().length, 0);
  assert.equal(found[0]!.executorId, null);
});

test("leaving on your own looks nothing up", async () => {
  const { socket, client, found, auditCalls } = await lookup([]);
  let left = false;
  client.on("memberLeave", () => (left = true));
  socket.receive({ type: "ServerMemberLeave", id: SERVER, user: TARGET, reason: "Leave" });
  await waitFor(() => left);
  assert.equal(auditCalls().length, 0);
  assert.deepEqual(found, []);
});

test("auditLookup: false turns it off", async () => {
  const { socket, client, found, auditCalls } = await lookup([], { auditLookup: false });
  let left = false;
  client.on("memberLeave", () => (left = true));
  socket.receive({ type: "ServerMemberLeave", id: SERVER, user: TARGET, reason: "Kick" });
  await waitFor(() => left);
  assert.equal(auditCalls().length, 0);
  assert.deepEqual(found, []);
});

test("role and channel deletes are looked up too", async () => {
  const { socket, found } = await lookup([
    page(entry({ type: "RoleDelete", role: id(105), name: "Helpers" })),
    page(entry({ type: "ChannelDelete", channel: CHANNEL, name: "general" })),
  ]);
  socket.receive({ type: "ServerRoleDelete", id: SERVER, role_id: id(105) });
  await waitFor(() => found.length === 1);
  socket.receive({ type: "ChannelDelete", id: CHANNEL });
  await waitFor(() => found.length === 2);
  assert.deepEqual(found.map((f) => [f.action, f.targetId]), [
    ["RoleDelete", id(105)],
    ["ChannelDelete", CHANNEL],
  ]);
  assert.equal(found[1]!.executorId, MOD);
});

test("a failed lookup is reported and still emits once", async () => {
  const { socket, found, errors, client } = await lookup([]);
  client.rest.request = async () => {
    throw new Error("network down");
  };
  socket.receive({ type: "ServerMemberLeave", id: SERVER, user: TARGET, reason: "Kick" });
  await waitFor(() => found.length === 1);
  assert.equal(found[0]!.executorId, null);
  assert.equal((errors[0] as Error).message, "network down");
});
