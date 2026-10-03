import { defineCommand } from "../../../src/index.ts";

export default defineCommand({
  name: "ping",
  description: "Check the bot is alive",
  run: (ctx) => ctx.reply("pong"),
});
