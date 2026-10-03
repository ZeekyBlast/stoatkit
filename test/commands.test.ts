import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Client, ClientOptions } from "../src/client.ts";
import type { CommandContext } from "../src/commands/registry.ts";
import { StoatAPIError } from "../src/rest/errors.ts";
import { Member } from "../src/structures/member.ts";
import { json } from "./helpers/fetch.ts";
import { waitFor } from "./helpers/wait.ts";
import { connected, destroyClients, id, BOT, CHANNEL, READY, SERVER, USER } from "./helpers/client.ts";

afterEach(destroyClients);

const OWNER = USER;
const MOD = id(120);
const PLEB = id(121);
const OTHER_BOT = id(122);
const ROLE_MODS = id(123);
const DM_CHANNEL = id(124);

const raw = (user: string, roles: string[] = []) => ({
  _id: { server: SERVER, user },
  joined_at: "2026-10-01T00:00:00.000Z",
  roles,
});

const COMMAND_READY = {
  ...READY,
  users: [...READY.users, { _id: OTHER_BOT, username: "otherbot", discriminator: "0006", bot: { owner: OWNER } }],
  servers: [
    {
      _id: SERVER,
      owner: OWNER,
      name: "S",
      channels: [CHANNEL],
      default_permissions: 1048576 + 4194304, // ViewChannel + SendMessage
      approximate_member_count: 4,
      roles: { [ROLE_MODS]: { _id: ROLE_MODS, name: "Mods", permissions: { a: 64, d: 0 }, rank: 0 } }, // KickMembers
    },
  ],
  channels: [...READY.channels, { _id: DM_CHANNEL, channel_type: "DirectMessage", active: true, recipients: [BOT, PLEB] }],
  members: [raw(BOT)],
};

let n = 200;
/** A Message frame from `author` that carries its member, like Stoat sends. */
const say = (author: string, content: string, channel = CHANNEL, roles: string[] = []) => ({
  type: "Message",
  _id: id(n++),
  channel,
  author,
  content,
  member: raw(author, roles),
});

/** A client whose replies are collected. */
async function bot(options: Partial<ClientOptions> = {}) {
  const replies: unknown[] = [];
  const ctx = await connected({
    ready: COMMAND_READY,
    options: { prefix: "-", ...options },
    routes: {
      [`POST /channels/${CHANNEL}/messages`]: (body) => {
        replies.push((body as { content?: string }).content ?? body);
        return json(200, { _id: id(n++), channel: CHANNEL, author: BOT, content: "" });
      },
      [`GET /servers/${SERVER}/members/${PLEB}`]: () => json(200, raw(PLEB)),
    },
  });
  return { ...ctx, replies };
}

function addKick(client: Client, runs: Array<{ target: Member; reason: string | undefined }>) {
  client.commands.add({
    name: "kick",
    aliases: ["boot"],
    description: "Kick a member",
    args: { target: "member", reason: "rest?" },
    permissions: ["KickMembers"],
    run: (_ctx, args) => {
      runs.push(args);
    },
  });
}

test("a command runs with parsed arguments", async () => {
  const { client, socket } = await bot();
  const runs: Array<{ target: Member; reason: string | undefined }> = [];
  addKick(client, runs);
  socket.receive(say(MOD, `-kick <@${PLEB}> being rude`, CHANNEL, [ROLE_MODS]));
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0]!.target.id, PLEB);
  assert.equal(runs[0]!.reason, "being rude");
});

test("aliases and any case work", async () => {
  const { client, socket } = await bot();
  const runs: Array<{ target: Member; reason: string | undefined }> = [];
  addKick(client, runs);
  socket.receive(say(MOD, `-BOOT <@${PLEB}>`, CHANNEL, [ROLE_MODS]));
  await waitFor(() => runs.length === 1);
});

test("ctx carries the server, channel, member and a reply", async () => {
  const { client, socket, replies } = await bot();
  let seen: CommandContext | undefined;
  client.commands.add({
    name: "ping",
    run: async (ctx) => {
      seen = ctx;
      await ctx.reply("pong");
    },
  });
  socket.receive(say(PLEB, "-ping"));
  await waitFor(() => replies.length === 1);
  assert.equal(seen!.server.id, SERVER);
  assert.equal(seen!.channel.id, CHANNEL);
  assert.equal(seen!.member.id, PLEB);
  assert.equal(seen!.prefix, "-");
  assert.deepEqual(replies, ["pong"]);
});

test("the prefix can come from a per-server lookup", async () => {
  const asked: string[] = [];
  const { client, socket, replies } = await bot({
    prefix: async (serverId) => {
      asked.push(serverId);
      return "v!";
    },
  });
  client.commands.add({ name: "ping", run: (ctx) => ctx.reply("pong") });
  socket.receive(say(PLEB, "-ping"));
  socket.receive(say(PLEB, "v!ping"));
  await waitFor(() => replies.length === 1);
  assert.deepEqual(asked, [SERVER, SERVER]);
});

test("ignored: bots, the bot itself, DMs, unknown commands, no prefix, a bare prefix", async () => {
  const { client, socket, errors } = await bot();
  let runs = 0;
  client.commands.add({ name: "ping", run: () => void runs++ });
  socket.receive({ ...say(OTHER_BOT, "-ping"), user: { _id: OTHER_BOT, username: "otherbot", discriminator: "0006", bot: { owner: OWNER } } });
  socket.receive(say(BOT, "-ping"));
  socket.receive(say(PLEB, "-ping", DM_CHANNEL));
  socket.receive(say(PLEB, "-pong"));
  socket.receive(say(PLEB, "ping"));
  socket.receive(say(PLEB, "-"));
  socket.receive(say(PLEB, "- ping"));
  socket.receive(say(PLEB, "-ping")); // the only one that runs
  await waitFor(() => runs === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.deepEqual(errors, []);
});

test("missing permissions get a reply and the command doesn't run", async () => {
  const { client, socket, replies } = await bot();
  const runs: Array<{ target: Member; reason: string | undefined }> = [];
  addKick(client, runs);
  socket.receive(say(PLEB, `-kick <@${MOD}>`));
  await waitFor(() => replies.length === 1);
  assert.deepEqual(replies, ["You need KickMembers to use this."]);
  assert.equal(runs.length, 0);
});

test("the owner passes every permission check", async () => {
  const { client, socket } = await bot();
  const runs: Array<{ target: Member; reason: string | undefined }> = [];
  addKick(client, runs);
  socket.receive(say(OWNER, `-kick <@${PLEB}>`));
  await waitFor(() => runs.length === 1);
});

test("a missing argument replies with usage", async () => {
  const { client, socket, replies } = await bot();
  addKick(client, []);
  socket.receive(say(MOD, "-kick", CHANNEL, [ROLE_MODS]));
  await waitFor(() => replies.length === 1);
  assert.deepEqual(replies, ["Missing `target`. Usage: `-kick <target> [reason...]`"]);
});

test("an invalid argument says what was wrong", async () => {
  const { client, socket, replies } = await bot();
  client.commands.add({ name: "slow", args: { seconds: "number" }, run: () => {} });
  socket.receive(say(PLEB, "-slow lots"));
  await waitFor(() => replies.length === 1);
  assert.deepEqual(replies, ["`lots` isn't a valid number for `seconds`."]);
});

test("Stoat refusing an action becomes a plain reply, not an error report", async () => {
  const { client, socket, replies, errors } = await bot();
  client.commands.add({
    name: "ban",
    run: () => {
      throw new StoatAPIError(403, "MissingPermission", "PUT /servers/S/bans/U", { type: "MissingPermission", permission: "BanMembers" });
    },
  });
  client.commands.add({
    name: "kick",
    run: () => {
      throw new StoatAPIError(403, "NotElevated", "DELETE /servers/S/members/U", { type: "NotElevated" });
    },
  });
  socket.receive(say(PLEB, "-ban"));
  socket.receive(say(PLEB, "-kick"));
  await waitFor(() => replies.length === 2);
  assert.deepEqual(replies.sort(), ["I'm missing BanMembers.", "They rank at or above me."]);
  assert.deepEqual(errors, []);
});

test("a bug in a command is reported and the user gets a generic reply", async () => {
  const { client, socket, replies, errors } = await bot();
  client.commands.add({
    name: "oops",
    run: () => {
      throw new Error("bug");
    },
  });
  socket.receive(say(PLEB, "-oops"));
  await waitFor(() => replies.length === 1);
  assert.deepEqual(replies, ["Something went wrong running that command."]);
  assert.equal((errors[0] as Error).message, "bug");
});

test("formatCommandError replaces the replies; null means stay quiet", async () => {
  const { client, socket, replies } = await bot({
    formatCommandError: (error, ctx) => (ctx.command.name === "quiet" ? null : `custom: ${(error as Error).name}`),
  });
  client.commands.add({ name: "slow", args: { seconds: "number" }, run: () => {} });
  client.commands.add({ name: "quiet", args: { seconds: "number" }, run: () => {} });
  socket.receive(say(PLEB, "-quiet"));
  socket.receive(say(PLEB, "-slow"));
  await waitFor(() => replies.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replies, ["custom: CommandError"]);
});

test("list, get and usage feed a help command", async () => {
  const { client } = await bot();
  addKick(client, []);
  client.commands.add({ name: "ping", description: "Pong", category: "Fun", run: () => {} });
  assert.deepEqual(client.commands.list().map((c) => c.name), ["kick", "ping"]);
  assert.equal(client.commands.get("BOOT")?.name, "kick");
  assert.equal(client.commands.usage(client.commands.get("kick")!, "-"), "-kick <target> [reason...]");
  assert.equal(client.commands.usage(client.commands.get("ping")!), "ping");
});

test("add rejects a rest argument that isn't last, and taken names", async () => {
  const { client } = await bot();
  addKick(client, []);
  assert.throws(() => client.commands.add({ name: "bad", args: { reason: "rest", who: "member" }, run: () => {} }), /must be the last/);
  assert.throws(() => client.commands.add({ name: "BOOT", run: () => {} }), /already taken/);
});

test("an echoed argument can't break out of its code span to ping anyone", async () => {
  const { client, socket, replies } = await bot();
  client.commands.add({ name: "whois", args: { target: "user" }, run: () => {} });
  socket.receive(say(PLEB, "-whois a`@everyone"));
  socket.receive(say(PLEB, `-whois ${"x".repeat(300)}`));
  await waitFor(() => replies.length === 2);
  assert.equal(replies[0], "`a'@everyone` isn't a valid user for `target`.");
  assert.ok((replies[1] as string).length < 200, "a long argument is cut short");
});

test("add rejects an argument type it doesn't know", async () => {
  const { client } = await bot();
  assert.throws(
    () => client.commands.add({ name: "typo", args: { who: "memebr" }, run: () => {} } as never),
    /typo: unknown argument type "memebr"/,
  );
});
