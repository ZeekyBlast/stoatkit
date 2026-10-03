import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { json } from "./helpers/fetch.ts";
import { waitFor } from "./helpers/wait.ts";
import { connected, destroyClients, id, CHANNEL, READY, SERVER, USER } from "./helpers/client.ts";
import { log } from "./fixtures/load/log.ts";

const COMMANDS = new URL("./fixtures/load/commands", import.meta.url);
const EVENTS = new URL("./fixtures/load/events", import.meta.url);
const NEWBIE = id(130);

beforeEach(() => {
  log.length = 0;
});
afterEach(destroyClients);

const LOAD_READY = {
  ...READY,
  servers: [{ _id: SERVER, owner: USER, name: "S", channels: [CHANNEL], default_permissions: 1048576 + 4194304, approximate_member_count: 1 }],
};

test("loadCommands loads nested files and skips helpers, notes and declaration files", async () => {
  const { client } = await connected({ ready: LOAD_READY });
  const result = await client.loadCommands(COMMANDS);
  assert.deepEqual(result.loaded, ["moderation/kick.ts", "ping.ts"]);
  assert.deepEqual(result.failed, ["broken.ts", "explodes.ts"]);
  assert.deepEqual(client.commands.list().map((c) => c.name), ["kick", "ping"]);
  assert.deepEqual(client.commands.get("kick")?.permissions, ["KickMembers"]);
});

test("each file that fails to load is reported by name, and the rest still load", async () => {
  const { client, errors } = await connected({ ready: LOAD_READY });
  await client.loadCommands(COMMANDS);
  const messages = errors.map((e) => (e as Error).message);
  assert.deepEqual(messages, [
    "Couldn't load broken.ts: its default export isn't a command; wrap it in defineCommand()",
    "Couldn't load explodes.ts: top-level boom",
  ]);
});

test("a loaded command runs like any other", async () => {
  const replies: unknown[] = [];
  const { client, socket } = await connected({
    ready: LOAD_READY,
    options: { prefix: "-" },
    routes: {
      [`POST /channels/${CHANNEL}/messages`]: (body) => {
        replies.push((body as { content: string }).content);
        return json(200, { _id: id(131), channel: CHANNEL, author: USER, content: "" });
      },
    },
  });
  await client.loadCommands(COMMANDS);
  socket.receive({
    type: "Message",
    _id: id(132),
    channel: CHANNEL,
    author: USER,
    content: "-ping",
    member: { _id: { server: SERVER, user: USER }, joined_at: "2026-10-01T00:00:00.000Z" },
  });
  await waitFor(() => replies.length === 1);
  assert.deepEqual(replies, ["pong"]);
});

test("loading the same folder twice fails each duplicate instead of crashing", async () => {
  const { client } = await connected({ ready: LOAD_READY });
  await client.loadCommands(COMMANDS);
  const again = await client.loadCommands(COMMANDS);
  assert.deepEqual(again.loaded, []);
  assert.deepEqual(again.failed, ["broken.ts", "explodes.ts", "moderation/kick.ts", "ping.ts"]);
});

test("a folder path given as a string works too", async () => {
  const { client } = await connected({ ready: LOAD_READY });
  const result = await client.loadCommands(fileURLToPath(COMMANDS));
  assert.deepEqual(result.loaded, ["moderation/kick.ts", "ping.ts"]);
});

test("a folder that doesn't exist is an error, not zero commands", async () => {
  const { client } = await connected({ ready: LOAD_READY });
  await assert.rejects(client.loadCommands(new URL("./fixtures/load/nope", import.meta.url)), { code: "ENOENT" });
});

test("loadEvents listens with each file, passing the client last", async () => {
  const { client, socket } = await connected({
    ready: LOAD_READY,
    routes: { [`GET /users/${NEWBIE}`]: () => json(200, { _id: NEWBIE, username: "newbie", discriminator: "0007" }) },
  });
  const result = await client.loadEvents(EVENTS);
  assert.deepEqual(result.loaded, ["first-ready.ts", "joined.ts", "throws.ts"]);
  socket.receive({ type: "ServerMemberJoin", id: SERVER, user: NEWBIE, member: { _id: { server: SERVER, user: NEWBIE }, joined_at: "2026-10-02T12:00:00.000Z" } });
  await waitFor(() => log.length === 1);
  assert.deepEqual(log, [`joined ${NEWBIE} seen by vela`]);
});

test("once: true listens only the first time", async () => {
  const { client } = await connected({ ready: LOAD_READY });
  await client.loadEvents(EVENTS);
  client.emit("reconnected", { gapMs: 5 });
  client.emit("reconnected", { gapMs: 9 });
  assert.deepEqual(log, ["reconnected after 5"]);
});

test("a listener that fails is reported with its file name", async () => {
  const { client, socket, errors } = await connected({
    ready: LOAD_READY,
    routes: { [`GET /users/${NEWBIE}`]: () => json(200, { _id: NEWBIE, username: "newbie", discriminator: "0007" }) },
  });
  await client.loadEvents(EVENTS);
  socket.receive({ type: "ServerMemberJoin", id: SERVER, user: NEWBIE, member: { _id: { server: SERVER, user: NEWBIE }, joined_at: "2026-10-02T12:00:00.000Z" } });
  await waitFor(() => errors.length === 1);
  assert.equal((errors[0] as Error).message, "throws.ts (memberJoin) failed: listener boom");
  assert.equal(log.length, 1, "the other memberJoin file still ran");
});

test("an event file with a misspelled event name fails to load, by name", async () => {
  const { client, errors } = await connected({ ready: LOAD_READY });
  const result = await client.loadEvents(new URL("./fixtures/load/bad-events", import.meta.url));
  assert.deepEqual(result, { loaded: [], failed: ["typo.ts"] });
  assert.equal((errors[0] as Error).message, 'Couldn\'t load typo.ts: Unknown event "memberjoin"');
});
