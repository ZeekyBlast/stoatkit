import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { defineEvent, findModuleFiles, isCommand, parseArgs, type ClientOptions } from "../src/index.ts";
import { json } from "./helpers/fetch.ts";
import { waitFor } from "./helpers/wait.ts";
import { connected, destroyClients, id, BOT, CHANNEL, READY, SERVER, USER } from "./helpers/client.ts";

afterEach(destroyClients);

const PLEB = id(140);
const NEWBIE = id(141);
const HOOK_READY = {
  ...READY,
  servers: [{ _id: SERVER, owner: USER, name: "S", channels: [CHANNEL], default_permissions: 1048576 + 4194304, approximate_member_count: 2 }],
};

let n = 300;
const say = (author: string, content: string) => ({
  type: "Message",
  _id: id(n++),
  channel: CHANNEL,
  author,
  content,
  member: { _id: { server: SERVER, user: author }, joined_at: "2026-10-01T00:00:00.000Z" },
});

async function bot(options: Partial<ClientOptions> = {}, routes: Record<string, () => Response> = {}) {
  const replies: string[] = [];
  const ctx = await connected({
    ready: HOOK_READY,
    options: { prefix: "-", ...options },
    routes: {
      [`POST /channels/${CHANNEL}/messages`]: (body) => {
        replies.push((body as { content: string }).content);
        return json(200, { _id: id(n++), channel: CHANNEL, author: BOT, content: "" });
      },
      ...routes,
    },
  });
  return { ...ctx, replies };
}

test("beforeCommand returning false stops the command; anything else lets it run", async () => {
  const used = new Map<string, number>();
  const { client, socket, replies } = await bot({
    // A 1-use cooldown per user and command.
    beforeCommand: async (ctx) => {
      const key = `${ctx.member.id}:${ctx.command.name}`;
      if (used.has(key)) {
        await ctx.reply("Slow down.");
        return false;
      }
      used.set(key, 1);
    },
  });
  let runs = 0;
  client.commands.add({ name: "ping", run: () => void runs++ });
  socket.receive(say(PLEB, "-ping"));
  socket.receive(say(PLEB, "-ping"));
  await waitFor(() => replies.length === 1);
  assert.equal(runs, 1);
  assert.deepEqual(replies, ["Slow down."]);
});

test("beforeCommand runs before permission checks, so it can silence anyone", async () => {
  const { client, socket, replies } = await bot({ beforeCommand: (ctx) => ctx.member.id !== PLEB });
  let ran = false;
  client.commands.add({ name: "ban", permissions: ["BanMembers"], run: () => void (ran = true) });
  socket.receive(say(PLEB, "-ban"));
  socket.receive(say(USER, "-ban")); // the owner: passes the hook and the permission check
  await waitFor(() => ran);
  assert.deepEqual(replies, []);
});

test("a beforeCommand that throws is reported, and the user gets the generic reply", async () => {
  const { client, socket, replies, errors } = await bot({
    beforeCommand: () => {
      throw new Error("hook bug");
    },
  });
  client.commands.add({ name: "ping", run: () => {} });
  socket.receive(say(PLEB, "-ping"));
  await waitFor(() => replies.length === 1);
  assert.deepEqual(replies, ["Something went wrong running that command."]);
  assert.equal((errors[0] as Error).message, "hook bug");
});

test("with no commands added, the built-in handler stays out of the way", async () => {
  let prefixLookups = 0;
  const { client, socket, replies } = await bot({
    prefix: () => {
      prefixLookups++;
      return "-";
    },
  });
  // Your own handler, built from stoatkit's parts.
  client.on("messageCreate", async (message) => {
    if (!message.content.startsWith("?double ")) return;
    const { value } = await parseArgs({ value: "number" }, message.content.slice("?double ".length), {
      client,
      serverId: SERVER,
    });
    await message.reply(String(value * 2));
  });
  socket.receive(say(PLEB, "?double 21"));
  socket.receive(say(PLEB, "-ping"));
  await waitFor(() => replies.length === 1);
  assert.deepEqual(replies, ["42"]);
  assert.equal(prefixLookups, 0);
});

test("addEvent wires a definition with the client last and names failures by label", async () => {
  const { client, socket, errors } = await bot(
    {},
    { [`GET /users/${NEWBIE}`]: () => json(200, { _id: NEWBIE, username: "newbie", discriminator: "0008" }) },
  );
  const seen: string[] = [];
  client.addEvent(
    defineEvent({
      name: "memberJoin",
      run: (member, c) => {
        seen.push(`${member.id} ${c.user?.username}`);
        throw new Error("nope");
      },
    }),
    "plugins/welcome",
  );
  socket.receive({ type: "ServerMemberJoin", id: SERVER, user: NEWBIE, member: { _id: { server: SERVER, user: NEWBIE }, joined_at: "2026-10-02T12:00:00.000Z" } });
  await waitFor(() => errors.length === 1);
  assert.deepEqual(seen, [`${NEWBIE} vela`]);
  assert.equal((errors[0] as Error).message, "plugins/welcome (memberJoin) failed: nope");
});

test("the loader's parts are there for your own loader", async () => {
  const files = await findModuleFiles(new URL("./fixtures/load/commands", import.meta.url));
  assert.deepEqual(files.map((f) => f.relative), ["broken.ts", "explodes.ts", "moderation/kick.ts", "ping.ts"]);
  const ping = (await import(new URL("./fixtures/load/commands/ping.ts", import.meta.url).href)) as { default: unknown };
  assert.equal(isCommand(ping.default), true);
  assert.equal(isCommand({ name: "x" }), false);
});

test("addEvent rejects an event name the client never emits", async () => {
  const { client } = await bot();
  assert.throws(() => client.addEvent({ name: "memberjoin", run: () => {} } as never), /Unknown event "memberjoin"/);
});
