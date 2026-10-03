import { defineCommand } from "../../../../src/index.ts";

export default defineCommand({
  name: "timeout",
  description: "Time a member out",
  args: { target: "member", length: "duration", reason: "rest?" },
  permissions: ["TimeoutMembers"],
  run: async (ctx, { target, length, reason }) => {
    if (!ctx.member.canModerate(target)) return ctx.reply("They rank at or above you.");
    await target.timeout(length, reason);
    await ctx.reply(`Timed out ${target.displayName}.`);
  },
});
