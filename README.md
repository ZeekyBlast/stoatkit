# stoatkit

[![npm](https://img.shields.io/npm/v/stoatkit)](https://www.npmjs.com/package/stoatkit)
[![ci](https://github.com/ZeekyBlast/stoatkit/actions/workflows/ci.yml/badge.svg)](https://github.com/ZeekyBlast/stoatkit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/stoatkit)](LICENSE)

A bot framework for [Stoat](https://stoat.chat) (formerly Revolt) with discord.js-style ergonomics.

> **Status: 0.0.x — early.** The API will change between releases until 0.1.0.

## Install

```sh
npm i stoatkit
```

Needs Node.js 22.4 or newer. No runtime dependencies: stoatkit uses Node's built-in `fetch` and `WebSocket`. TypeScript users also need `@types/node`.

## Example

```ts
import { Client } from "stoatkit";

const client = new Client({ token: process.env.STOAT_TOKEN! });

client.on("ready", () => console.log(`Logged in as ${client.user?.username}`));

client.on("messageCreate", async (message) => {
  if (message.authorId === client.user?.id) return;
  if (message.content === "!ping") await message.reply("pong");
});

client.on("error", (err) => console.error(err));

await client.login();
```

Create a bot under **User Settings → My Bots** in Stoat, invite it to a server, and pass its token as `STOAT_TOKEN`.

## What works today

- **REST with rate limits.** Requests queue per Stoat rate-limit bucket (all `/servers/:id` calls share one), wait out `429`s, and retry server errors with backoff. Message sends carry an `Idempotency-Key`, so a retry never posts twice. Failures throw a typed `StoatAPIError`.
- **A gateway that keeps itself alive.** Heartbeats, reconnects with exponential backoff, and drops connections that open but never authenticate. `reconnected` tells you how long you were gone; `ready` fires again after every reconnect.
- **Edits and deletes with the original message.** Stoat's delete event only carries an id. stoatkit keeps the newest 200 messages per channel (`messageCacheSize`), so `messageDelete` hands you the full message when it was cached, and `messageUpdate` gives you the before and after.
- **Listener errors never crash the bot.** A throwing or rejecting listener is reported on `error` (or logged when nothing listens).
- **Types generated from Stoat's OpenAPI spec**, exported as `StoatSchemas`.

## Events

| Event | Arguments |
|---|---|
| `ready` | — |
| `messageCreate` | `message` |
| `messageUpdate` | `before` (`Message` or `null` if it wasn't cached), `after` |
| `messageDelete` | `Message`, or `{ id, channelId }` if it wasn't cached |
| `messageDeleteBulk` | `{ channelId, ids, messages }` |
| `reconnected` | `{ gapMs }` |
| `error` | `err` |
| `fatal` | `err` — the token was rejected; the client stops |

## Development

```sh
npm ci
npm test            # node:test, runs the .ts sources directly
npm run typecheck
npm run build       # emits dist/
npm run check:spec  # warns when Stoat's live API version moved past the generated types
npm run gen:types   # regenerate src/generated/ from Stoat's OpenAPI spec
```

`test/fixtures/session.json` is a real (anonymized) gateway session, replayed in `test/replay.test.ts`. To record a fresh one, put `STOAT_TOKEN=...` in `.env` and run `node --env-file=.env scripts/record.ts`. Check the result for personal data before committing it.

## License

[MIT](LICENSE)
