import { defineCommand } from "../../../../src/loader.ts";

export default defineCommand({
  name: "ping",
  description: "Pong",
  run: (ctx) => ctx.reply("pong"),
});
