import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../src/structures/message.ts";
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
  assert.equal(system!.isSystem, true);
  assert.equal(hook!.isWebhook, true);
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
