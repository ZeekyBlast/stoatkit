// The quickest way to start: one file per command, one per event, loaded from folders.
// Run from the repo root: node --env-file=.env examples/folder-bot/index.ts
import { Client } from "../../src/index.ts";

const token = process.env.STOAT_TOKEN;
if (!token) {
  console.error("Set STOAT_TOKEN in .env");
  process.exit(1);
}

const client = new Client({ token, prefix: "!" });
// Listen first, so a file that fails to load is reported here too.
client.on("error", (err) => console.error(err));
client.on("fatal", (err) => {
  console.error(err.message);
  process.exit(1);
});

// URLs relative to this file, so the same code works from src/ and from a build.
const commands = await client.loadCommands(new URL("./commands", import.meta.url));
const events = await client.loadEvents(new URL("./events", import.meta.url));
console.log(`Loaded ${commands.loaded.length} commands and ${events.loaded.length} events`);
if (commands.failed.length + events.failed.length > 0) process.exit(1); // each failure was printed above

await client.login();
