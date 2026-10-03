import { defineCommand } from "../../../../../src/loader.ts";
import { reasonOrDefault } from "../_helpers.ts";

export default defineCommand({
  name: "kick",
  args: { target: "member", reason: "rest?" },
  permissions: ["KickMembers"],
  // Typed through defineCommand: target is a Member, reason is string | undefined.
  run: (_ctx, { target, reason }) => target.kick(reasonOrDefault(reason)),
});
