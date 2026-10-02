# stoatkit

A bot framework for [Stoat](https://stoat.chat) (formerly Revolt) with discord.js-style ergonomics.

> **Status: 0.0.x — early.** The API will change between releases until 0.1.0.

## Requirements

Node.js 22.4 or newer. stoatkit has no runtime dependencies: it uses Node's built-in `fetch` and `WebSocket`.

## Install

```sh
npm i stoatkit
```

## Example

```ts
import { Client } from "stoatkit";

const client = new Client({ token: process.env.STOAT_TOKEN! });

client.on("ready", () => console.log(`Logged in as ${client.user?.username}`));

client.on("messageCreate", async (message) => {
  if (message.authorId === client.user?.id) return;
  if (message.content === "!ping") await message.reply("pong");
});

await client.login();
```

## What works today

- **REST with rate limits.** Requests queue per Stoat rate-limit bucket (all `/servers/:id` calls share one), wait out `429`s, and retry server errors with backoff. Failures are a typed `StoatAPIError`.
- **A gateway that keeps itself alive.** Heartbeats, reconnects with exponential backoff, and a `reconnected` event that tells you how long you were gone.
- **Edits and deletes with the original message.** Stoat's delete event only carries an id; stoatkit keeps a per-channel message cache so `messageDelete` and `messageUpdate` hand you the full message.
- **Types generated from Stoat's OpenAPI spec**, exported as `StoatSchemas`.

## License

MIT
