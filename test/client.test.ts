import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/client.ts";
import { Message } from "../src/structures/message.ts";
import { StoatAPIError } from "../src/rest/errors.ts";
import { FakeSocket } from "./helpers/socket.ts";
import { routeFetch, json } from "./helpers/fetch.ts";
import { waitFor } from "./helpers/wait.ts";

/** Valid ULIDs that all decode to 2026-10-02T12:00:00.000Z. */
const id = (n: number) => "01M3Y7RKG0" + String(n).padStart(16, "0");
const BOT = id(1);
const USER = id(2);
const CHANNEL = id(3);
const SERVER = id(4);

const BOT_USER = { _id: BOT, username: "vela", discriminator: "0001", bot: { owner: USER } };
const READY = {
  type: "Ready",
  users: [BOT_USER, { _id: USER, username: "alice", discriminator: "1234", display_name: "Alice" }],
  channels: [{ _id: CHANNEL, channel_type: "TextChannel", name: "general", server: SERVER }],
  servers: [],
  members: [],
};

const msg = (n: number, content: string, author = USER) => ({ type: "Message", _id: id(n), channel: CHANNEL, author, content });

const clients: Client[] = [];
beforeEach(() => {
  FakeSocket.instances = [];
});
afterEach(() => {
  for (const c of clients.splice(0)) c.destroy();
});

async function connected(
  options: { messageCacheSize?: number; routes?: Record<string, (body: unknown) => Response>; errorListener?: boolean } = {},
) {
  const { fetch, calls } = routeFetch({
    "GET /": () => json(200, { revolt: "0.15.7", ws: "wss://events.test" }),
    "GET /users/@me": () => json(200, BOT_USER),
    ...options.routes,
  });
  const client = new Client({
    token: "t0k",
    baseUrl: "https://api.test",
    fetch,
    WebSocket: FakeSocket,
    ...(options.messageCacheSize === undefined ? {} : { messageCacheSize: options.messageCacheSize }),
  });
  clients.push(client);
  const errors: unknown[] = [];
  if (options.errorListener !== false) client.on("error", (e) => errors.push(e));
  const loggedIn = client.login();
  await waitFor(() => FakeSocket.instances.length === 1);
  const socket = FakeSocket.instances[0]!;
  socket.open();
  socket.receive({ type: "Authenticated" });
  socket.receive(READY);
  await loggedIn;
  return { client, socket, calls, errors };
}

test("login discovers the gateway, loads the bot user and waits for Ready", async () => {
  const { client, calls } = await connected();
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ["GET /", "GET /users/@me"]);
  assert.equal(FakeSocket.instances[0]!.url, "wss://events.test?version=1&format=json");
  assert.equal(client.user?.id, BOT);
  assert.equal(client.users.get(USER)?.displayName, "Alice");
  assert.equal(client.channels.get(CHANNEL)?.name, "general");
});

test("messageCreate gives a Message with its author", async () => {
  const { client, socket } = await connected();
  const got: Message[] = [];
  client.on("messageCreate", (m) => got.push(m));
  socket.receive(msg(10, "hello"));
  assert.equal(got.length, 1);
  assert.ok(got[0] instanceof Message);
  assert.equal(got[0]!.content, "hello");
  assert.equal(got[0]!.author?.username, "alice");
  assert.equal(got[0]!.createdAt.toISOString(), "2026-10-02T12:00:00.000Z");
});

test("a message from an unknown user still arrives", async () => {
  const { client, socket } = await connected();
  const got: Message[] = [];
  client.on("messageCreate", (m) => got.push(m));
  socket.receive(msg(11, "hi", id(99)));
  assert.equal(got[0]!.authorId, id(99));
  assert.equal(got[0]!.author, undefined);
});

test("a user object sent with a message is cached", async () => {
  const { client, socket } = await connected();
  socket.receive({ ...msg(12, "hi", id(98)), user: { _id: id(98), username: "newbie", discriminator: "0002" } });
  assert.equal(client.users.get(id(98))?.username, "newbie");
});

test("reply posts to the channel with a reply reference", async () => {
  const posted: unknown[] = [];
  const { client, socket } = await connected({
    routes: {
      [`POST /channels/${CHANNEL}/messages`]: (body) => {
        posted.push(body);
        return json(200, { _id: id(20), channel: CHANNEL, author: BOT, content: "pong" });
      },
    },
  });
  let reply: Message | undefined;
  client.on("messageCreate", async (m) => {
    if (m.content === "!ping") reply = await m.reply("pong");
  });
  socket.receive(msg(13, "!ping"));
  await waitFor(() => reply !== undefined);
  assert.deepEqual(posted, [{ content: "pong", replies: [{ id: id(13), mention: false }] }]);
  assert.equal(reply!.content, "pong");
});

test("messageDelete hands over the cached message", async () => {
  const { client, socket } = await connected();
  const got: unknown[] = [];
  client.on("messageDelete", (m) => got.push(m));
  socket.receive(msg(14, "oops"));
  socket.receive({ type: "MessageDelete", id: id(14), channel: CHANNEL });
  assert.ok(got[0] instanceof Message);
  assert.equal((got[0] as Message).content, "oops");
});

test("messageDelete for an uncached message gives ids only", async () => {
  const { client, socket } = await connected();
  const got: unknown[] = [];
  client.on("messageDelete", (m) => got.push(m));
  socket.receive({ type: "MessageDelete", id: id(15), channel: CHANNEL });
  assert.deepEqual(got, [{ id: id(15), channelId: CHANNEL }]);
});

test("messageUpdate gives the before and after", async () => {
  const { client, socket } = await connected();
  const got: Array<[Message | null, Message]> = [];
  client.on("messageUpdate", (before, after) => got.push([before, after]));
  socket.receive(msg(16, "teh"));
  socket.receive({
    type: "MessageUpdate",
    id: id(16),
    channel: CHANNEL,
    data: { content: "the", edited: "2026-10-02T12:01:00.000Z" },
    clear: [],
  });
  assert.equal(got[0]![0]?.content, "teh");
  assert.equal(got[0]![1].content, "the");
  assert.equal(got[0]![1].editedAt?.toISOString(), "2026-10-02T12:01:00.000Z");
  assert.equal(client.messages.get(CHANNEL, id(16))?.content, "the");
});

test("messageUpdate for an uncached message fetches it", async () => {
  const { client, socket } = await connected({
    routes: {
      [`GET /channels/${CHANNEL}/messages/${id(17)}`]: () =>
        json(200, { _id: id(17), channel: CHANNEL, author: USER, content: "fetched" }),
    },
  });
  const got: Array<[Message | null, Message]> = [];
  client.on("messageUpdate", (before, after) => got.push([before, after]));
  socket.receive({ type: "MessageUpdate", id: id(17), channel: CHANNEL, data: { content: "fetched" }, clear: [] });
  await waitFor(() => got.length === 1);
  assert.equal(got[0]![0], null);
  assert.equal(got[0]![1].content, "fetched");
});

test("bulk delete returns the cached messages it can", async () => {
  const { client, socket } = await connected();
  let got: { channelId: string; ids: string[]; messages: Message[] } | undefined;
  client.on("messageDeleteBulk", (x) => {
    got = x;
  });
  socket.receive(msg(18, "a"));
  socket.receive({ type: "BulkMessageDelete", channel: CHANNEL, ids: [id(18), id(19)] });
  assert.equal(got?.channelId, CHANNEL);
  assert.deepEqual(got?.ids, [id(18), id(19)]);
  assert.deepEqual(got?.messages.map((m) => m.content), ["a"]);
});

test("the message cache keeps only the newest N per channel", async () => {
  const { client, socket } = await connected({ messageCacheSize: 2 });
  socket.receive(msg(30, "one"));
  socket.receive(msg(31, "two"));
  socket.receive(msg(32, "three"));
  assert.equal(client.messages.get(CHANNEL, id(30)), undefined);
  assert.equal(client.messages.get(CHANNEL, id(32))?.content, "three");
});

test("channels created later are cached", async () => {
  const { client, socket } = await connected();
  socket.receive({ type: "ChannelCreate", _id: id(50), channel_type: "TextChannel", name: "new", server: SERVER });
  assert.equal(client.channels.get(id(50))?.name, "new");
  socket.receive({ type: "ChannelDelete", id: id(50) });
  assert.equal(client.channels.get(id(50)), undefined);
});

test("a throwing listener is reported and does not stop later events", async () => {
  const { client, socket, errors } = await connected();
  const seen: string[] = [];
  client.on("messageCreate", (m) => {
    if (m.content === "boom") throw new Error("listener bug");
    seen.push(m.content);
  });
  socket.receive(msg(40, "boom"));
  socket.receive(msg(41, "fine"));
  assert.equal((errors[0] as Error).message, "listener bug");
  assert.deepEqual(seen, ["fine"]);
});

test("a rejecting async listener is reported", async () => {
  const { client, socket, errors } = await connected();
  client.on("messageCreate", async () => {
    throw new Error("async bug");
  });
  socket.receive(msg(42, "x"));
  await waitFor(() => errors.length === 1);
  assert.equal((errors[0] as Error).message, "async bug");
});

test("login rejects with StoatAPIError when the token is wrong", async () => {
  const { fetch } = routeFetch({
    "GET /": () => json(200, { ws: "wss://events.test" }),
    "GET /users/@me": () => new Response("<h1>401</h1>", { status: 401, headers: { "content-type": "text/html" } }),
  });
  const client = new Client({ token: "bad", baseUrl: "https://api.test", fetch, WebSocket: FakeSocket });
  clients.push(client);
  await assert.rejects(client.login(), (e: unknown) => e instanceof StoatAPIError && e.type === "HTTP_401");
});

test("login rejects when the gateway refuses the session", async () => {
  const { fetch } = routeFetch({
    "GET /": () => json(200, { ws: "wss://events.test" }),
    "GET /users/@me": () => json(200, BOT_USER),
  });
  const client = new Client({ token: "bad", baseUrl: "https://api.test", fetch, WebSocket: FakeSocket });
  clients.push(client);
  const loggedIn = client.login();
  await waitFor(() => FakeSocket.instances.length === 1);
  FakeSocket.instances[0]!.open();
  FakeSocket.instances[0]!.receive({ type: "Error", data: { type: "InvalidSession" } });
  await assert.rejects(loggedIn, /InvalidSession/);
});

test("a rejecting async listener with no error listener is logged, not fatal", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const { client, socket } = await connected({ errorListener: false });
  client.on("messageCreate", async () => {
    throw new Error("no permission");
  });
  socket.receive(msg(43, "x"));
  await waitFor(() => logged.mock.callCount() === 1);
  assert.equal((logged.mock.calls[0]!.arguments[0] as Error).message, "no permission");
});

test("an update frame without data is reported, not a crash", async () => {
  const { socket, errors } = await connected();
  socket.receive(msg(44, "a"));
  socket.receive({ type: "MessageUpdate", id: id(44), channel: CHANNEL });
  await waitFor(() => errors.length === 1);
});
