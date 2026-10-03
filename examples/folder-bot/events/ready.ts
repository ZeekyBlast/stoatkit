import { defineEvent } from "../../../src/index.ts";

export default defineEvent({
  name: "ready",
  once: true,
  run: (client) => console.log(`Logged in as ${client.user?.username}. Try !ping`),
});
