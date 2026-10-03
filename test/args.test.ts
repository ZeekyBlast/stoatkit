import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CommandError, parseArgs, tokenize, usage, type ArgSpec } from "../src/commands/args.ts";
import { Member } from "../src/structures/member.ts";
import { json } from "./helpers/fetch.ts";
import { connected, destroyClients, id, CHANNEL, READY, SERVER, USER } from "./helpers/client.ts";

afterEach(destroyClients);

const TARGET = id(110);
const STRANGER = id(111);
const ROLE = id(112);
const FOREIGN_CHANNEL = id(113);

const ARGS_READY = {
  ...READY,
  servers: [
    {
      _id: SERVER,
      owner: USER,
      name: "S",
      channels: [CHANNEL],
      default_permissions: 0,
      approximate_member_count: 2,
      roles: { [ROLE]: { _id: ROLE, name: "Muted Folks", permissions: { a: 0, d: 0 }, rank: 0 } },
    },
  ],
  channels: [...READY.channels, { _id: FOREIGN_CHANNEL, channel_type: "TextChannel", name: "elsewhere", server: id(114) }],
};

async function parser() {
  const { client } = await connected({
    ready: ARGS_READY,
    routes: {
      [`GET /servers/${SERVER}/members/${TARGET}`]: () =>
        json(200, { _id: { server: SERVER, user: TARGET }, joined_at: "2026-10-01T00:00:00.000Z" }),
      [`GET /users/${STRANGER}`]: () => json(200, { _id: STRANGER, username: "stranger", discriminator: "0005" }),
    },
  });
  return <S extends ArgSpec>(spec: S, input: string) => parseArgs(spec, input, { client, serverId: SERVER });
}

/** Asserts a CommandError with this code and argument. */
const commandError = (code: string, arg?: string) => (err: unknown) =>
  err instanceof CommandError && err.code === code && err.arg === arg;

test("tokenize splits on whitespace and keeps quoted words together", () => {
  assert.deepEqual(
    tokenize(`  warn  "two words"\nnext`).map((t) => t.text),
    ["warn", "two words", "next"],
  );
  assert.deepEqual(tokenize(`"unclosed quote`).map((t) => t.text), [`"unclosed`, "quote"]);
  assert.deepEqual(tokenize("   "), []);
});

test("parses a member, a duration and the rest", async () => {
  const parse = await parser();
  const args = await parse({ target: "member", length: "duration", reason: "rest?" }, `<@${TARGET}> 10m  spamming  "links"`);
  assert.ok(args.target instanceof Member);
  assert.equal(args.target.id, TARGET);
  assert.equal(args.length, 600_000);
  assert.equal(args.reason, `spamming  "links"`);
  // Type check: these lines fail `npm run typecheck` if ParsedArgs infers the wrong types.
  const ms: number = args.length;
  const reason: string | undefined = args.reason;
  void ms, reason;
});

test("a bare id works as well as a mention", async () => {
  const parse = await parser();
  const { who } = await parse({ who: "user" }, STRANGER.toLowerCase());
  assert.equal(who.username, "stranger");
});

test("roles by mention, id or name; channels only from this server", async () => {
  const parse = await parser();
  assert.equal((await parse({ r: "role" }, `<%${ROLE}>`)).r.id, ROLE);
  assert.equal((await parse({ r: "role" }, `"muted folks"`)).r.id, ROLE);
  assert.equal((await parse({ c: "channel" }, `<#${CHANNEL}>`)).c.id, CHANNEL);
  await assert.rejects(parse({ c: "channel" }, `<#${FOREIGN_CHANNEL}>`), commandError("InvalidArgument", "c"));
});

test("numbers and strings", async () => {
  const parse = await parser();
  assert.deepEqual(await parse({ seconds: "number", word: "string" }, "10 hello"), { seconds: 10, word: "hello" });
  await assert.rejects(parse({ seconds: "number" }, "ten"), commandError("InvalidArgument", "seconds"));
});

test("a missing optional argument is undefined; a missing required one is an error", async () => {
  const parse = await parser();
  const args = await parse({ who: "member", reason: "rest?" }, `<@${TARGET}>`);
  assert.equal(args.who.id, TARGET);
  assert.equal(args.reason, undefined);
  await assert.rejects(parse({ who: "member", length: "duration" }, `<@${TARGET}>`), commandError("MissingArgument", "length"));
});

test("bad input is an InvalidArgument that says what was typed", async () => {
  const parse = await parser();
  await assert.rejects(parse({ length: "duration" }, "0m"), (err: unknown) => {
    assert.ok(err instanceof CommandError);
    assert.equal(err.code, "InvalidArgument");
    assert.equal(err.argType, "duration");
    assert.equal(err.value, "0m");
    return true;
  });
  await assert.rejects(parse({ who: "member" }, "<@not-a-ulid>"), commandError("InvalidArgument", "who"));
  await assert.rejects(parse({ who: "member" }, `<%${ROLE}>`), commandError("InvalidArgument", "who"));
});

test("someone who isn't in the server is an InvalidArgument, not a crash", async () => {
  const parse = await parser();
  await assert.rejects(parse({ who: "member" }, `<@${STRANGER}>`), commandError("InvalidArgument", "who"));
});

test("usage lists the arguments", () => {
  assert.equal(usage({ target: "member", length: "duration", reason: "rest?" }), "<target> <length> [reason...]");
  assert.equal(usage({}), "");
});
