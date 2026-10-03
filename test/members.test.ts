import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Member } from "../src/structures/member.ts";
import { StoatAPIError } from "../src/rest/errors.ts";
import { missingPermissions } from "../src/permissions.ts";
import { json } from "./helpers/fetch.ts";
import { waitFor } from "./helpers/wait.ts";
import { connected, destroyClients, id, msg, BOT, CHANNEL, READY, SERVER, USER } from "./helpers/client.ts";

afterEach(destroyClients);

const OWNER = USER;
const MOD = id(80);
const NEWBIE = id(81);
const OTHER_MOD = id(82);
const ROLE_MODS = id(60);
const ROLE_HELPERS = id(61);
const ROLE_GONE = id(69);

const member = (user: string, extra: object = {}) => ({ _id: { server: SERVER, user }, joined_at: "2026-10-01T00:00:00.000Z", ...extra });

/** Owner USER; the bot ranks as a helper; MOD has Mods (KickMembers). */
const MEMBER_READY = {
  ...READY,
  servers: [
    {
      _id: SERVER,
      owner: OWNER,
      name: "Vela Test Server",
      channels: [CHANNEL],
      default_permissions: 1048576 + 4194304, // ViewChannel + SendMessage
      approximate_member_count: 4,
      roles: {
        [ROLE_MODS]: { _id: ROLE_MODS, name: "Mods", permissions: { a: 64, d: 0 }, rank: 0 },
        [ROLE_HELPERS]: { _id: ROLE_HELPERS, name: "Helpers", permissions: { a: 8388608, d: 0 }, rank: 1 },
      },
    },
  ],
  channels: [
    {
      _id: CHANNEL,
      channel_type: "TextChannel",
      name: "general",
      server: SERVER,
      role_permissions: { [ROLE_HELPERS]: { a: 0, d: 4194304 } }, // helpers can't talk in #general
    },
  ],
  members: [member(BOT, { roles: [ROLE_HELPERS] })],
};

test("Ready caches the bot's own member, reachable as server.me", async () => {
  const { client } = await connected({ ready: MEMBER_READY });
  const me = client.servers.get(SERVER)!.me;
  assert.ok(me instanceof Member);
  assert.equal(me.id, BOT);
  assert.deepEqual(me.roles.map((r) => r.name), ["Helpers"]);
});

test("a message's member is cached", async () => {
  const { client, socket } = await connected({ ready: MEMBER_READY });
  socket.receive({ ...msg(10, "hi", MOD), member: member(MOD, { roles: [ROLE_MODS], nickname: "Moddy" }) });
  const cached = client.members.get(SERVER, MOD);
  assert.equal(cached?.displayName, "Moddy");
  assert.equal(cached?.joinedAt.toISOString(), "2026-10-01T00:00:00.000Z");
});

test("memberJoin fires at once, without spending a request on the user", async () => {
  const { client, socket, calls, errors } = await connected({ ready: MEMBER_READY });
  const joined: Member[] = [];
  client.on("memberJoin", (m) => joined.push(m));
  socket.receive({ type: "ServerMemberJoin", id: SERVER, user: NEWBIE, member: member(NEWBIE) });
  assert.equal(joined.length, 1, "fired synchronously, so a raid of joins isn't queued behind user fetches");
  assert.equal(client.members.get(SERVER, NEWBIE), joined[0]);
  assert.equal(joined[0]!.user, undefined);
  assert.equal(joined[0]!.displayName, NEWBIE);
  assert.equal(calls.filter((c) => c.url.includes(`/users/${NEWBIE}`)).length, 0);
  assert.deepEqual(errors, []);
});

test("memberLeave hands over the cached member and the reason", async () => {
  const { client, socket } = await connected({ ready: MEMBER_READY });
  const left: Array<[unknown, string]> = [];
  client.on("memberLeave", (m, reason) => left.push([m, reason]));
  socket.receive({ ...msg(11, "bye", MOD), member: member(MOD) });
  socket.receive({ type: "ServerMemberLeave", id: SERVER, user: MOD, reason: "Kick" });
  assert.ok(left[0]![0] instanceof Member);
  assert.equal(left[0]![1], "Kick");
  assert.equal(client.members.get(SERVER, MOD), undefined);

  socket.receive({ type: "ServerMemberLeave", id: SERVER, user: NEWBIE, reason: "Ban" });
  assert.deepEqual(left[1], [{ id: NEWBIE, serverId: SERVER }, "Ban"]);
});

test("memberUpdate gives before and after, including cleared fields", async () => {
  const { client, socket } = await connected({ ready: MEMBER_READY });
  const got: Array<[Member | null, Member]> = [];
  client.on("memberUpdate", (before, after) => got.push([before, after]));
  socket.receive({ ...msg(12, "hi", MOD), member: member(MOD, { nickname: "Moddy" }) });

  socket.receive({
    type: "ServerMemberUpdate",
    id: { server: SERVER, user: MOD },
    data: { timeout: "2026-10-02T13:00:00.000Z", roles: [ROLE_MODS] },
    clear: ["Nickname"],
  });
  await waitFor(() => got.length === 1);
  const [before, after] = got[0]!;
  assert.equal(before?.nickname, "Moddy");
  assert.equal(after.nickname, null);
  assert.equal(after.timeoutUntil?.toISOString(), "2026-10-02T13:00:00.000Z");
  assert.deepEqual(after.roleIds, [ROLE_MODS]);
  assert.equal(client.members.get(SERVER, MOD), after);
});

test("memberUpdate for an uncached member fetches it", async () => {
  const { client, socket } = await connected({
    ready: MEMBER_READY,
    routes: { [`GET /servers/${SERVER}/members/${NEWBIE}`]: () => json(200, member(NEWBIE, { nickname: "fresh" })) },
  });
  const got: Array<[Member | null, Member]> = [];
  client.on("memberUpdate", (before, after) => got.push([before, after]));
  socket.receive({ type: "ServerMemberUpdate", id: { server: SERVER, user: NEWBIE }, data: { nickname: "fresh" }, clear: [] });
  await waitFor(() => got.length === 1);
  assert.equal(got[0]![0], null);
  assert.equal(got[0]![1].nickname, "fresh");
});

test("fetchMember asks Stoat once, then uses the cache", async () => {
  const { client, calls } = await connected({
    ready: MEMBER_READY,
    routes: { [`GET /servers/${SERVER}/members/${MOD}`]: () => json(200, member(MOD)) },
  });
  const first = await client.fetchMember(SERVER, MOD);
  const second = await client.fetchMember(SERVER, MOD);
  assert.equal(first, second);
  assert.equal(calls.filter((c) => c.url.endsWith(`/members/${MOD}`)).length, 1);
  await assert.rejects(client.fetchMember(SERVER, NEWBIE), (e: unknown) => e instanceof StoatAPIError && e.status === 404);
});

test("permissions combine the server default and roles; permissionsIn adds channel overrides", async () => {
  const { client, socket } = await connected({ ready: MEMBER_READY });
  socket.receive({ ...msg(13, "hi", MOD), member: member(MOD, { roles: [ROLE_MODS] }) });
  const mod = client.members.get(SERVER, MOD)!;
  const me = client.servers.get(SERVER)!.me!;
  const general = client.channels.get(CHANNEL)!;

  assert.deepEqual(missingPermissions(mod.permissions, ["KickMembers", "SendMessage"]), []);
  assert.deepEqual(missingPermissions(me.permissions, ["ManageMessages", "SendMessage"]), []);
  assert.deepEqual(missingPermissions(me.permissionsIn(general), ["ManageMessages", "SendMessage"]), ["SendMessage"]);
});

test("a timed-out member loses permissions until the timeout passes", async () => {
  const { client, socket } = await connected({ ready: MEMBER_READY });
  socket.receive({ ...msg(14, "hi", MOD), member: member(MOD, { roles: [ROLE_MODS], timeout: "2999-01-01T00:00:00.000Z" }) });
  const mod = client.members.get(SERVER, MOD)!;
  assert.equal(mod.isTimedOut(), true);
  assert.deepEqual(missingPermissions(mod.permissions, ["KickMembers"]), ["KickMembers"]);
  assert.equal(mod.isTimedOut(Date.parse("3000-01-01T00:00:00.000Z")), false);
});

test("canModerate follows Stoat's ranking", async () => {
  const { client, socket } = await connected({ ready: MEMBER_READY });
  const join = (user: string, roles: string[]) => socket.receive({ ...msg(20, "hi", user), member: member(user, { roles }) });
  join(OWNER, []);
  join(MOD, [ROLE_MODS]);
  join(OTHER_MOD, [ROLE_MODS, ROLE_GONE]);
  join(NEWBIE, []);
  const get = (user: string) => client.members.get(SERVER, user)!;
  const me = client.servers.get(SERVER)!.me!;

  assert.equal(get(OWNER).canModerate(get(MOD)), true, "the owner outranks everyone");
  assert.equal(get(MOD).canModerate(get(OWNER)), false, "nobody outranks the owner");
  assert.equal(get(MOD).canModerate(me), true, "rank 0 beats rank 1");
  assert.equal(me.canModerate(get(MOD)), false, "rank 1 can't touch rank 0");
  assert.equal(get(MOD).canModerate(get(OTHER_MOD)), false, "equal rank is not enough");
  assert.equal(me.canModerate(get(NEWBIE)), true, "any role beats no role");
  assert.equal(get(NEWBIE).canModerate(get(NEWBIE)), false, "never yourself");
  assert.equal(get(OTHER_MOD).rank, 0, "a deleted role id is ignored");
});

test("leaving a server drops its members", async () => {
  const { client, socket } = await connected({ ready: MEMBER_READY });
  socket.receive({ ...msg(15, "hi", MOD), member: member(MOD) });
  socket.receive({ type: "ServerDelete", id: SERVER });
  assert.equal(client.members.get(SERVER, MOD), undefined);
  assert.equal(client.members.get(SERVER, BOT), undefined);
});

test("the bot being kicked drops that server", async () => {
  const { client, socket } = await connected({ ready: MEMBER_READY });
  const left: string[] = [];
  client.on("memberLeave", (m, reason) => left.push(`${m.id} ${reason}`));
  socket.receive({ type: "ServerMemberLeave", id: SERVER, user: BOT, reason: "Kick" });
  assert.deepEqual(left, [`${BOT} Kick`]);
  assert.equal(client.servers.get(SERVER), undefined);
  assert.equal(client.channels.get(CHANNEL), undefined);
});
