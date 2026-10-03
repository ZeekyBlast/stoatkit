import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../src/structures/message.ts";
import type { InviteInfo } from "../src/client.ts";
import { StoatAPIError } from "../src/rest/errors.ts";
import { json } from "./helpers/fetch.ts";
import { waitFor } from "./helpers/wait.ts";
import { connected, destroyClients, id, msg, BOT, CHANNEL, READY, SERVER, USER } from "./helpers/client.ts";

afterEach(destroyClients);

const file = { _id: "f1", tag: "attachments", filename: "cat.png", metadata: { type: "Image", width: 1, height: 1 }, content_type: "image/png", size: 123 };

test("messages expose attachments, mentions, and whether they're system or webhook messages", async () => {
  const { client, socket } = await connected();
  const got: Message[] = [];
  client.on("messageCreate", (m) => got.push(m));
  socket.receive({ ...msg(10, `hi <@${USER}>`), attachments: [file], mentions: [USER], role_mentions: [id(60)] });
  socket.receive({ ...msg(11, ""), author: "00000000000000000000000000", system: { type: "user_joined", id: USER } });
  socket.receive({ ...msg(12, "from a hook"), webhook: { name: "Hook", avatar: null } });
  socket.receive(msg(13, "plain"));
  const [rich, system, hook, plain] = got;
  assert.deepEqual(rich!.attachments, [{ id: "f1", filename: "cat.png", contentType: "image/png", size: 123 }]);
  assert.deepEqual(rich!.mentionIds, [USER]);
  assert.deepEqual(rich!.roleMentionIds, [id(60)]);
  assert.deepEqual([rich!.isSystem, rich!.isWebhook], [false, false]);
  assert.deepEqual([system!.isSystem, system!.isWebhook], [true, false]);
  assert.deepEqual([hook!.isSystem, hook!.isWebhook], [false, true]);
  assert.deepEqual([plain!.attachments, plain!.mentionIds, plain!.roleMentionIds], [[], [], []]);
});

test("message.member is the author's cached member", async () => {
  const { client, socket } = await connected();
  const got: Message[] = [];
  client.on("messageCreate", (m) => got.push(m));
  socket.receive({ ...msg(14, "hi"), member: { _id: { server: SERVER, user: USER }, joined_at: "2026-10-01T00:00:00.000Z" } });
  socket.receive(msg(15, "nobody cached", id(77)));
  assert.equal(got[0]!.member?.id, USER);
  assert.equal(got[1]!.member, undefined);
});

test("channels expose nsfw and description", async () => {
  const { client, socket } = await connected();
  socket.receive({ type: "ChannelCreate", _id: id(50), channel_type: "TextChannel", name: "art", server: SERVER, nsfw: true, description: "Art only" });
  const art = client.channels.get(id(50))!;
  assert.deepEqual([art.nsfw, art.description], [true, "Art only"]);
  const general = client.channels.get(CHANNEL)!;
  assert.deepEqual([general.nsfw, general.description], [false, null]);
});

test("a channel update can set nsfw and clear the description", async () => {
  const { client, socket } = await connected();
  socket.receive({ type: "ChannelCreate", _id: id(51), channel_type: "TextChannel", name: "art", server: SERVER, description: "Art only" });
  socket.receive({ type: "ChannelUpdate", id: id(51), data: { nsfw: true }, clear: ["Description"] });
  const art = client.channels.get(id(51))!;
  assert.deepEqual([art.nsfw, art.description], [true, null]);
});

test("fetchInvite resolves a server invite, and an unknown code to null", async () => {
  const { client } = await connected({
    routes: {
      "GET /invites/abc": () =>
        json(200, { type: "Server", code: "abc", server_id: SERVER, server_name: "Test", channel_id: CHANNEL, user_name: "x", member_count: 3 }),
    },
  });
  assert.deepEqual(await client.fetchInvite("abc"), { code: "abc", type: "Server", serverId: SERVER, serverName: "Test", channelId: CHANNEL });
  assert.equal(await client.fetchInvite("nope"), null);
});

test("fetchInvite: group invites, codes that aren't invite tokens, and other errors", async () => {
  const { client, calls } = await connected({
    routes: {
      "GET /invites/grp": () => json(200, { type: "Group", code: "grp", channel_id: CHANNEL, channel_name: "g", user_name: "x" }),
      "GET /invites/boom": () => json(403, { type: "Forbidden" }),
    },
  });
  assert.deepEqual(await client.fetchInvite("grp"), { code: "grp", type: "Group", serverId: null, serverName: null, channelId: CHANNEL });
  const before = calls.length;
  for (const code of ["..", ".", "a/b", "x?y", ""]) assert.equal(await client.fetchInvite(code), null, code);
  assert.equal(calls.length, before, "nothing that isn't an invite token is sent");
  await assert.rejects(client.fetchInvite("boom"), StoatAPIError);
});

test("InviteInfo narrows on type", () => {
  const serverName = (info: InviteInfo): string => (info.type === "Server" ? info.serverName : "group");
  assert.equal(serverName({ code: "a", type: "Server", serverId: SERVER, serverName: "S", channelId: CHANNEL }), "S");
});

test("commands ignore webhook and system messages", async () => {
  const replies: unknown[] = [];
  const { client, socket } = await connected({
    ready: { ...READY, servers: [{ _id: SERVER, owner: USER, name: "S", channels: [CHANNEL], default_permissions: 0, approximate_member_count: 1 }] },
    options: { prefix: "!" },
    routes: {
      [`POST /channels/${CHANNEL}/messages`]: (body) => {
        replies.push(body);
        return json(200, { _id: id(31), channel: CHANNEL, author: BOT, content: "" });
      },
    },
  });
  client.commands.add({ name: "ping", run: (ctx) => ctx.reply("pong") });
  const member = { _id: { server: SERVER, user: USER }, joined_at: "2026-10-01T00:00:00.000Z" };
  socket.receive({ ...msg(20, "!ping"), member, webhook: { name: "Hook", avatar: null } });
  socket.receive({ ...msg(21, "!ping"), member, system: { type: "text", content: "!ping" } });
  socket.receive({ ...msg(22, "!ping"), member });
  await waitFor(() => replies.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.length, 1);
});
