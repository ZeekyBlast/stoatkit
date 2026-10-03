// A small moderation bot: commands with typed arguments, permission checks, embeds and audit lookups.
// Run from the repo root: node --env-file=.env examples/mod-bot.ts
import { Client, EmbedBuilder } from "../src/index.ts";

const token = process.env.STOAT_TOKEN;
if (!token) {
  console.error("Set STOAT_TOKEN in .env");
  process.exit(1);
}

const client = new Client({ token, prefix: "!" });

client.commands.add({
  name: "help",
  description: "List commands",
  run: (ctx) =>
    ctx.reply(
      new EmbedBuilder()
        .setTitle("Commands")
        .setDescription(client.commands.list().map((c) => `\`${client.commands.usage(c, ctx.prefix)}\` ${c.description ?? ""}`).join("\n")),
    ),
});

client.commands.add({
  name: "kick",
  description: "Kick a member",
  args: { target: "member", reason: "rest?" },
  permissions: ["KickMembers"],
  run: async (ctx, { target, reason }) => {
    if (!ctx.server.me?.canModerate(target)) return ctx.reply("They rank at or above me.");
    if (!ctx.member.canModerate(target)) return ctx.reply("They rank at or above you.");
    await target.kick(reason);
    await ctx.reply(
      new EmbedBuilder()
        .setTitle("Kicked")
        .setColour(0xe67e22)
        .addFields({ name: "Member", value: target.displayName }, { name: "Reason", value: reason ?? "none" }),
    );
  },
});

client.commands.add({
  name: "timeout",
  aliases: ["mute"],
  description: "Time a member out",
  args: { target: "member", length: "duration", reason: "rest?" },
  permissions: ["TimeoutMembers"],
  run: async (ctx, { target, length, reason }) => {
    if (!ctx.member.canModerate(target)) return ctx.reply("They rank at or above you.");
    await target.timeout(length, reason);
    await ctx.reply(`Timed out ${target.displayName} for ${length / 60_000} minutes.`);
  },
});

client.commands.add({
  name: "slowmode",
  description: "Set this channel's slowmode (0 turns it off)",
  args: { seconds: "number" },
  permissions: ["ManageChannel"],
  run: async (ctx, { seconds }) => {
    await ctx.channel.setSlowmode(seconds);
    await ctx.reply(seconds > 0 ? `Slowmode is ${seconds}s.` : "Slowmode is off.");
  },
});

client.on("memberLeave", (member, reason) => console.log(`${member.id} left (${reason})`));
client.on("auditLogEntry", (entry) => {
  const by = entry.executorId ? (client.users.get(entry.executorId)?.username ?? entry.executorId) : "someone";
  console.log(`${entry.action} on ${entry.targetId} by ${by}${entry.reason ? `: ${entry.reason}` : ""}`);
});
client.on("ready", () => console.log(`Logged in as ${client.user?.username}. Try !help`));
client.on("error", (err) => console.error(err));
client.on("fatal", (err) => {
  console.error(err.message);
  process.exit(1);
});

await client.login();
