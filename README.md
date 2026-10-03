# stoatkit

[![npm](https://img.shields.io/npm/v/stoatkit)](https://www.npmjs.com/package/stoatkit)
[![ci](https://github.com/ZeekyBlast/stoatkit/actions/workflows/ci.yml/badge.svg)](https://github.com/ZeekyBlast/stoatkit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/stoatkit)](LICENSE)

A bot framework for [Stoat](https://stoat.chat) (formerly Revolt) with discord.js-style ergonomics.

> **Status: 0.1.x.** Usable for real bots; the API may still change between minor versions until 1.0.

## Install

```sh
npm i stoatkit
```

Needs Node.js 22.4 or newer. No runtime dependencies: stoatkit uses Node's built-in `fetch` and `WebSocket`. TypeScript users also need `@types/node`.

## Example

```ts
import { Client, EmbedBuilder } from "stoatkit";

const client = new Client({ token: process.env.STOAT_TOKEN!, prefix: "!" });

client.commands.add({
  name: "timeout",
  args: { target: "member", length: "duration", reason: "rest?" },
  permissions: ["TimeoutMembers"],
  run: async (ctx, { target, length, reason }) => {
    if (!ctx.member.canModerate(target)) return ctx.reply("They rank at or above you.");
    await target.timeout(length, reason);
    await ctx.reply(new EmbedBuilder().setTitle("Timed out").setDescription(target.displayName));
  },
});

client.on("auditLogEntry", (entry) => console.log(`${entry.action} by ${entry.executorId ?? "unknown"}`));
client.on("error", (err) => console.error(err));

await client.login();
```

Create a bot under **User Settings → My Bots** in Stoat, invite it to a server, and pass its token as `STOAT_TOKEN`.

Two runnable examples: [`examples/folder-bot/`](examples/folder-bot) (one file per command and event, the easiest start) and [`examples/mod-bot.ts`](examples/mod-bot.ts) (everything in one file).

## Commands and events: pick your level

**Hop on.** One file per command or event, loaded from folders:

```ts
// index.ts
await client.loadCommands(new URL("./commands", import.meta.url));
await client.loadEvents(new URL("./events", import.meta.url));

// commands/ping.ts
export default defineCommand({ name: "ping", run: (ctx) => ctx.reply("pong") });

// events/welcome.ts
export default defineEvent({ name: "memberJoin", run: (member, client) => console.log(member.id) });
```

Subfolders are fine. Files and folders whose names start with `_` are skipped, so shared helpers can live in `_utils.ts`. A file that fails to load (no default export, a misspelled event name, a duplicate command) is reported by name, and the rest still load.

**Tune the built-in handler.** `prefix` can be a per-server lookup, `formatCommandError` rewrites the error replies, and `beforeCommand` runs before every command (return `false` to stop it) for cooldowns, blocklists or your own permission rules. Give commands your own fields with declaration merging:

```ts
import type { ArgSpec } from "stoatkit";
declare module "stoatkit" {
  interface Command<S extends ArgSpec = ArgSpec> {
    cooldownSeconds?: number;
  }
}
```

**Build your own.** Leave `client.commands` empty and the built-in handler never runs. Use the parts:
- for commands: `parseArgs`, `tokenize`, `usage`, `CommandError` and `missingPermissions`;
- for loaders: `findModuleFiles`, `isCommand`, `isEvent` and `client.addEvent()`.

**No hot reload.** Node can't unload an ES module, so restart the bot to pick up changes. It starts in about a second.

## What works today

- **Commands** with typed arguments (`member`, `user`, `channel`, `role`, `duration`, `number`, `string`, `rest`, any of them optional with `?`), per-server prefixes, permission checks, and clear replies when someone uses a command wrong. Replies never echo user input in a way that can ping anyone.
- **Permissions** computed the way Stoat does, bit for bit: `member.permissionsIn(channel)`, `member.canModerate(target)`, and `missingPermissions(value, ["BanMembers"])`.
- **Moderation**: `member.timeout()`, `untimeout()`, `kick()`, `ban()`, `server.unban()`, `channel.setSlowmode()`, `channel.bulkDelete()` and `user.dm()`, with reasons in the audit log (made header-safe, so an em dash or emoji never fails the action).
- **Who did it**: after a kick, ban, role delete or channel delete, an `auditLogEntry` event names who did it. This needs View Audit Logs, and can be turned off with `auditLookup: false`.
- **Servers, roles, members and channels** in the cache, with before/after events.
- **Edits and deletes with the original message.** Stoat's delete event only carries an id. stoatkit keeps the newest 200 messages per channel (`messageCacheSize`), so `messageDelete` hands you the full message when it was cached, and `messageUpdate` gives you the before and after.
- **EmbedBuilder** with a discord.js-like API. Stoat embeds have no fields or footer, so those become markdown in the description.
- **REST with rate limits.** Requests queue per Stoat rate-limit bucket (all `/servers/:id` calls share one), wait out `429`s, and retry server errors with backoff. Message sends carry an `Idempotency-Key`, so a retry never posts twice. Failures throw a typed `StoatAPIError`.
- **A gateway that keeps itself alive.** Heartbeats, reconnects with exponential backoff, and drops connections that open but never authenticate. `reconnected` tells you how long you were gone; `ready` fires again after every reconnect.
- **Errors never crash the bot.** A throwing or rejecting listener, or a malformed gateway frame, is reported on `error` (or logged when nothing listens). An `error` listener that fails itself is logged, never fed back into itself.
- **Types generated from Stoat's OpenAPI spec**, exported as `StoatSchemas`.

## Events

| Event | Arguments |
|---|---|
| `ready` | — |
| `messageCreate` | `message` |
| `messageUpdate` | `before` (`Message` or `null` if it wasn't cached), `after` |
| `messageDelete` | `Message`, or `{ id, channelId }` if it wasn't cached |
| `messageDeleteBulk` | `{ channelId, ids, messages }` |
| `memberJoin` | `member`. A join carries no user object, so `member.user` may be `undefined`: call `client.fetchUser(member.id)` for the name |
| `memberLeave` | `Member`, or `{ id, serverId }` if it wasn't cached; then `reason`: `"Leave"`, `"Kick"` or `"Ban"` |
| `memberUpdate` | `before` (`Member` or `null` if it wasn't cached), `after` |
| `roleCreate` | `role` |
| `roleUpdate` | `before`, `after` |
| `roleDelete` | `Role`, or `{ id, serverId }` if it wasn't cached |
| `channelCreate` | `channel` |
| `channelUpdate` | `before`, `after` |
| `channelDelete` | `Channel`, or `{ id }` if it wasn't cached |
| `auditLogEntry` | `{ serverId, action, targetId, executorId, reason }`; `executorId` is `null` when it couldn't be found |
| `reconnected` | `{ gapMs }` |
| `error` | `err` |
| `fatal` | `err` — the token was rejected; the client stops |

## Upgrading from 0.0.x

- `send`, `reply` and `edit` now take a string, an `EmbedBuilder`, or `{ content, embeds }`. Plain strings work as before.
- `User`'s constructor is now `new User(client, raw)`. You only notice if you built `User` objects yourself.

## Development

```sh
npm ci
npm test            # node:test, runs the .ts sources directly
npm run typecheck
npm run build       # emits dist/
npm run check:spec  # warns when Stoat's live API version moved past the generated types
npm run gen:types   # regenerate src/generated/ from Stoat's OpenAPI spec
```

`test/fixtures/session.json` is a real gateway session, anonymized, replayed in `test/replay.test.ts`. To record a fresh one, put `STOAT_TOKEN=...` in `.env`, run `node --env-file=.env scripts/record.ts`, then anonymize it before committing: `node scripts/anonymize.ts test/fixtures/session.json test/fixtures/session.json`. It replaces ids, usernames, server names and avatar files; check the result for anything else personal (message text, for one).

## License

[MIT](LICENSE)
