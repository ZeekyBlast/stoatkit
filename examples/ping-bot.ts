// A minimal stoatkit bot: answers "!ping" with "pong".
// Run from the repo root: node --env-file=.env examples/ping-bot.ts
import { Client } from "../src/index.ts";

const token = process.env.STOAT_TOKEN;
if (!token) {
  console.error("Set STOAT_TOKEN in .env");
  process.exit(1);
}

const client = new Client({ token });

client.on("ready", () => console.log(`Logged in as ${client.user?.username}`));

client.on("messageCreate", async (message) => {
  if (message.authorId === client.user?.id) return;
  if (message.content === "!ping") {
    await message.reply(`pong · ${Date.now() - message.createdAt.getTime()}ms`);
  }
});

client.on("error", (err) => console.error(err));
client.on("reconnected", ({ gapMs }) => console.log(`Reconnected after ${gapMs}ms`));
client.on("fatal", (err) => {
  console.error(err.message);
  process.exit(1);
});

await client.login();
