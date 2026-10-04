import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../src/structures/message.ts";
import type { ClientEvents } from "../src/client.ts";
import { waitFor } from "./helpers/wait.ts";
import { connected, destroyClients, id, msg, BOT, CHANNEL, USER } from "./helpers/client.ts";

afterEach(destroyClients);

const noContent = () => new Response(null, { status: 204 });
const MSG = id(10);
const react = (type: string, emoji: string, user = USER) => ({ type, id: MSG, channel_id: CHANNEL, user_id: user, emoji_id: emoji });

test("a message exposes its reactions as emoji to user ids", async () => {
  const { client, socket } = await connected();
  const got: Message[] = [];
  client.on("messageCreate", (m) => got.push(m));
  socket.receive({ ...msg(10, "poll"), reactions: { "👍": [USER, BOT] } });
  socket.receive(msg(11, "none"));
  assert.deepEqual([...got[0]!.reactions], [["👍", [USER, BOT]]]);
  assert.equal(got[1]!.reactions.size, 0);
});

test("MessageReact emits messageReactionAdd and updates the cached message", async () => {
  const { client, socket } = await connected();
  const got: ClientEvents["messageReactionAdd"][0][] = [];
  client.on("messageReactionAdd", (r) => got.push(r));
  socket.receive(msg(10, "poll"));
  const original = client.messages.get(CHANNEL, MSG)!;
  socket.receive(react("MessageReact", "👍"));
  socket.receive(react("MessageReact", "👍", BOT));
  assert.deepEqual(
    got.map(({ message, ...rest }) => rest),
    [
      { messageId: MSG, channelId: CHANNEL, userId: USER, emoji: "👍" },
      { messageId: MSG, channelId: CHANNEL, userId: BOT, emoji: "👍" },
    ],
  );
  assert.deepEqual(got[1]!.message?.reactions.get("👍"), [USER, BOT]);
  assert.equal(client.messages.get(CHANNEL, MSG), got[1]!.message);
  assert.equal(original.reactions.size, 0, "the earlier Message is not mutated");
});

test("a repeated MessageReact doesn't list the user twice", async () => {
  const { client, socket } = await connected();
  socket.receive(msg(10, "poll"));
  socket.receive(react("MessageReact", "👍"));
  socket.receive(react("MessageReact", "👍"));
  assert.deepEqual(client.messages.get(CHANNEL, MSG)!.reactions.get("👍"), [USER]);
});

test("MessageUnreact emits messageReactionRemove and drops the emoji with its last user", async () => {
  const { client, socket } = await connected();
  const got: ClientEvents["messageReactionRemove"][0][] = [];
  client.on("messageReactionRemove", (r) => got.push(r));
  socket.receive({ ...msg(10, "poll"), reactions: { "👍": [USER, BOT] } });
  socket.receive(react("MessageUnreact", "👍"));
  assert.deepEqual(got[0]!.message?.reactions.get("👍"), [BOT]);
  socket.receive(react("MessageUnreact", "👍", BOT));
  assert.equal(got[1]!.userId, BOT);
  assert.equal(got[1]!.message?.reactions.has("👍"), false);
});

test("MessageRemoveReaction emits messageReactionRemoveEmoji and clears that emoji only", async () => {
  const { client, socket } = await connected();
  const got: ClientEvents["messageReactionRemoveEmoji"][0][] = [];
  client.on("messageReactionRemoveEmoji", (r) => got.push(r));
  socket.receive({ ...msg(10, "poll"), reactions: { "👍": [USER], "👎": [BOT] } });
  socket.receive({ type: "MessageRemoveReaction", id: MSG, channel_id: CHANNEL, emoji_id: "👍" });
  assert.deepEqual({ ...got[0]!, message: undefined }, { messageId: MSG, channelId: CHANNEL, emoji: "👍", message: undefined });
  assert.deepEqual([...got[0]!.message!.reactions], [["👎", [BOT]]]);
});

test("a reaction on an uncached message arrives with message: null and fetches nothing", async () => {
  const { client, socket, calls } = await connected();
  const got: ClientEvents["messageReactionAdd"][0][] = [];
  client.on("messageReactionAdd", (r) => got.push(r));
  const before = calls.length;
  socket.receive(react("MessageReact", "👍"));
  assert.equal(got[0]!.message, null);
  assert.equal(got[0]!.emoji, "👍");
  assert.equal(calls.length, before);
});

test("clearing all reactions arrives as messageUpdate with empty reactions", async () => {
  const { client, socket } = await connected();
  const got: Message[] = [];
  client.on("messageUpdate", (_before, after) => got.push(after));
  socket.receive({ ...msg(10, "poll"), reactions: { "👍": [USER] } });
  socket.receive({ type: "MessageUpdate", id: MSG, channel: CHANNEL, data: { reactions: {} } });
  await waitFor(() => got.length === 1);
  assert.equal(got[0]!.reactions.size, 0);
  assert.equal(got[0]!.content, "poll");
});

test("react, unreact and clearReactions hit Stoat's reaction routes", async () => {
  const thumbs = encodeURIComponent("👍");
  const base = `/channels/${CHANNEL}/messages/${MSG}/reactions`;
  const { client, socket, calls } = await connected({
    routes: { [`PUT ${base}/${thumbs}`]: noContent, [`DELETE ${base}/${thumbs}`]: noContent, [`DELETE ${base}`]: noContent },
  });
  socket.receive(msg(10, "poll"));
  const message = client.messages.get(CHANNEL, MSG)!;
  const before = calls.length;
  await message.react("👍");
  await message.unreact("👍");
  await message.unreact("👍", USER);
  await message.clearReactions("👍");
  await message.clearReactions();
  assert.deepEqual(
    calls.slice(before).map((c) => `${c.method} ${c.url.replace("https://api.test", "")}`),
    [
      `PUT ${base}/${thumbs}`,
      `DELETE ${base}/${thumbs}`,
      `DELETE ${base}/${thumbs}?user_id=${USER}`,
      `DELETE ${base}/${thumbs}?remove_all=true`,
      `DELETE ${base}`,
    ],
  );
});
