import { defineEvent } from "../../../../src/loader.ts";
import { log } from "../log.ts";

export default defineEvent({
  name: "memberJoin",
  // Typed from the name: member is a Member; the client always comes last.
  run: (member, client) => {
    log.push(`joined ${member.id} seen by ${client.user?.username}`);
  },
});
