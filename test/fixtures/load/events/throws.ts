import { defineEvent } from "../../../../src/loader.ts";

export default defineEvent({
  name: "memberJoin",
  run: async () => {
    throw new Error("listener boom");
  },
});
