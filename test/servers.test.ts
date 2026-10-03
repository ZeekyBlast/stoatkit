import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Channel } from "../src/structures/channel.ts";
import { Role } from "../src/structures/role.ts";
import { connected, destroyClients, id, BOT, CHANNEL, READY, SERVER, USER } from "./helpers/client.ts";

afterEach(destroyClients);

const MODS = id(60);
const MEMBERS = id(61);
const OTHER_SERVER = id(70);

/** Ready with one server that has two roles and a channel with overrides. */
const SERVER_READY = {
  ...READY,
  servers: [
    {
      _id: SERVER,
      owner: USER,
      name: "Vela Test Server",
      channels: [CHANNEL],
      default_permissions: 77014766592,
      approximate_member_count: 2,
      roles: {
        [MODS]: { _id: MODS, name: "Mods", permissions: { a: 64, d: 0 }, rank: 0, colour: "#ff0000" },
        [MEMBERS]: { _id: MEMBERS, name: "Members", permissions: { a: 0, d: 0 }, rank: 1 },
      },
    },
  ],
  channels: [
    {
      _id: CHANNEL,
      channel_type: "TextChannel",
      name: "general",
      server: SERVER,
      default_permissions: { a: 0, d: 4194304 },
      role_permissions: { [MODS]: { a: 4194304, d: 0 } },
      slowmode: 5,
    },
  ],
};

test("Ready fills servers, roles and channel permissions", async () => {
  const { client } = await connected({ ready: SERVER_READY });
  const server = client.servers.get(SERVER)!;
  assert.equal(server.name, "Vela Test Server");
  assert.equal(server.ownerId, USER);
  assert.equal(server.defaultPermissions, 77014766592);
  assert.equal(server.roles.get(MODS)?.name, "Mods");
  assert.equal(server.roles.get(MODS)?.rank, 0);
  assert.deepEqual(server.channels.map((c) => c.id), [CHANNEL]);

  const channel = client.channels.get(CHANNEL)!;
  assert.equal(channel.server, server);
  assert.deepEqual(channel.defaultPermissions, { a: 0, d: 4194304 });
  assert.deepEqual(channel.rolePermissions[MODS], { a: 4194304, d: 0 });
  assert.equal(channel.slowmode, 5);
});

test("a new role arrives as roleCreate", async () => {
  const { client, socket } = await connected({ ready: SERVER_READY });
  const created: Role[] = [];
  client.on("roleCreate", (role) => created.push(role));
  socket.receive({
    type: "ServerRoleUpdate",
    id: SERVER,
    role_id: id(62),
    data: { name: "Helpers", permissions: { a: 0, d: 0 }, rank: 2 },
    clear: [],
  });
  assert.equal(created[0]?.name, "Helpers");
  assert.equal(created[0]?.serverId, SERVER);
  assert.equal(client.servers.get(SERVER)!.roles.get(id(62)), created[0]);
});

test("a changed role arrives as roleUpdate with before and after", async () => {
  const { client, socket } = await connected({ ready: SERVER_READY });
  const got: Array<[Role, Role]> = [];
  client.on("roleUpdate", (before, after) => got.push([before, after]));
  socket.receive({ type: "ServerRoleUpdate", id: SERVER, role_id: MODS, data: { name: "Moderators" }, clear: ["Colour"] });
  assert.equal(got[0]![0].name, "Mods");
  assert.equal(got[0]![1].name, "Moderators");
  assert.equal(got[0]![1].colour, null);
  assert.equal(got[0]![1].rank, 0);
});

test("roleDelete hands over the deleted role", async () => {
  const { client, socket } = await connected({ ready: SERVER_READY });
  const got: unknown[] = [];
  client.on("roleDelete", (role) => got.push(role));
  socket.receive({ type: "ServerRoleDelete", id: SERVER, role_id: MEMBERS });
  assert.ok(got[0] instanceof Role);
  assert.equal((got[0] as Role).name, "Members");
  assert.equal(client.servers.get(SERVER)!.roles.has(MEMBERS), false);
});

test("reordering roles updates their ranks", async () => {
  const { client, socket } = await connected({ ready: SERVER_READY });
  socket.receive({ type: "ServerRoleRanksUpdate", id: SERVER, ranks: [MEMBERS, MODS, id(99)] });
  const roles = client.servers.get(SERVER)!.roles;
  assert.equal(roles.get(MEMBERS)?.rank, 0);
  assert.equal(roles.get(MODS)?.rank, 1);
});

test("role events for a server we don't know are ignored, not a crash", async () => {
  const { client, socket, errors } = await connected({ ready: SERVER_READY });
  const got: unknown[] = [];
  client.on("roleCreate", (role) => got.push(role));
  client.on("roleDelete", (role) => got.push(role));
  socket.receive({ type: "ServerRoleUpdate", id: OTHER_SERVER, role_id: id(63), data: { name: "x" }, clear: [] });
  socket.receive({ type: "ServerRoleRanksUpdate", id: OTHER_SERVER, ranks: [id(63)] });
  socket.receive({ type: "ServerRoleDelete", id: OTHER_SERVER, role_id: id(63) });
  assert.deepEqual(got, [{ id: id(63), serverId: OTHER_SERVER }]);
  assert.deepEqual(errors, []);
});

test("channelCreate, channelUpdate and channelDelete", async () => {
  const { client, socket } = await connected({ ready: SERVER_READY });
  const created: Channel[] = [];
  const updated: Array<[Channel, Channel]> = [];
  const deleted: unknown[] = [];
  client.on("channelCreate", (c) => created.push(c));
  client.on("channelUpdate", (before, after) => updated.push([before, after]));
  client.on("channelDelete", (c) => deleted.push(c));

  socket.receive({ type: "ChannelCreate", _id: id(64), channel_type: "TextChannel", name: "logs", server: SERVER });
  assert.equal(created[0]?.name, "logs");

  socket.receive({ type: "ChannelUpdate", id: CHANNEL, data: { name: "chat" }, clear: ["Slowmode", "DefaultPermissions"] });
  assert.equal(updated[0]![0].name, "general");
  assert.equal(updated[0]![1].name, "chat");
  assert.equal(updated[0]![1].slowmode, 0);
  assert.equal(updated[0]![1].defaultPermissions, null);
  assert.deepEqual(updated[0]![1].rolePermissions[MODS], { a: 4194304, d: 0 });

  socket.receive({ type: "ChannelDelete", id: id(64) });
  assert.equal((deleted[0] as Channel).name, "logs");
  socket.receive({ type: "ChannelDelete", id: id(65) });
  assert.deepEqual(deleted[1], { id: id(65) });
});

test("an update for an unknown channel is ignored", async () => {
  const { client, socket, errors } = await connected({ ready: SERVER_READY });
  let fired = false;
  client.on("channelUpdate", () => (fired = true));
  socket.receive({ type: "ChannelUpdate", id: id(66), data: { name: "dm" }, clear: [] });
  assert.equal(fired, false);
  assert.deepEqual(errors, []);
});

test("joining a server adds it; leaving drops it and its channels", async () => {
  const { client, socket } = await connected({ ready: SERVER_READY });
  socket.receive({
    type: "ServerCreate",
    id: OTHER_SERVER,
    server: { _id: OTHER_SERVER, owner: BOT, name: "Second", channels: [id(71)], default_permissions: 0, approximate_member_count: 1 },
    channels: [{ _id: id(71), channel_type: "TextChannel", name: "lobby", server: OTHER_SERVER }],
    emojis: [],
    voice_states: [],
  });
  assert.equal(client.servers.get(OTHER_SERVER)?.name, "Second");
  assert.equal(client.channels.get(id(71))?.name, "lobby");

  socket.receive({ type: "ServerUpdate", id: OTHER_SERVER, data: { name: "Renamed" }, clear: [] });
  assert.equal(client.servers.get(OTHER_SERVER)?.name, "Renamed");

  socket.receive({ type: "ServerDelete", id: OTHER_SERVER });
  assert.equal(client.servers.get(OTHER_SERVER), undefined);
  assert.equal(client.channels.get(id(71)), undefined);
  assert.ok(client.channels.get(CHANNEL));
});

test("a server joined later has the bot's member, like Ready's servers do", async () => {
  const { client, socket } = await connected({ ready: SERVER_READY });
  socket.receive({
    type: "ServerCreate",
    id: OTHER_SERVER,
    server: { _id: OTHER_SERVER, owner: USER, name: "New", channels: [], default_permissions: 1048576, approximate_member_count: 2 },
    channels: [],
    emojis: [],
    voice_states: [],
  });
  const me = client.servers.get(OTHER_SERVER)?.me;
  assert.equal(me?.id, BOT);
  assert.deepEqual(me?.roleIds, []);
});
