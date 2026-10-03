import { defineEvent } from "../../../src/index.ts";

export default defineEvent({
  name: "memberJoin",
  // A join carries no user object: fetch it when you want the name.
  run: async (member, client) => {
    const user = await client.fetchUser(member.id);
    console.log(`${user.displayName} joined ${member.server?.name}`);
  },
});
