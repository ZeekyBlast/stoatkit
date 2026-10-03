import { defineEvent } from "../../../../src/loader.ts";
import { log } from "../log.ts";

export default defineEvent({
  name: "reconnected",
  once: true,
  run: ({ gapMs }) => {
    log.push(`reconnected after ${gapMs}`);
  },
});
