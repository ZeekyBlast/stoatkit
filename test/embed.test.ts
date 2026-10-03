import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EmbedBuilder, toMessageBody } from "../src/embed.ts";
import { json } from "./helpers/fetch.ts";
import { connected, destroyClients, id, BOT, CHANNEL } from "./helpers/client.ts";

afterEach(destroyClients);

test("builds Stoat's embed body", () => {
  const embed = new EmbedBuilder()
    .setTitle("Warned")
    .setDescription("Be nice.")
    .setColour("#e74c3c")
    .setURL("https://stoat.chat")
    .setIconURL("https://example.com/icon.png");
  assert.deepEqual(embed.toJSON(), {
    title: "Warned",
    description: "Be nice.",
    colour: "#e74c3c",
    url: "https://stoat.chat",
    icon_url: "https://example.com/icon.png",
  });
});

test("fields and footer become markdown in the description", () => {
  const embed = new EmbedBuilder()
    .setDescription("Case 12")
    .addFields({ name: "Member", value: "<@01M3Y7RKG00000000000000002>" }, { name: "Reason", value: "spam" })
    .setFooter("Vela Heat");
  assert.equal(embed.toJSON().description, "Case 12\n\n**Member**\n<@01M3Y7RKG00000000000000002>\n\n**Reason**\nspam\n\n*Vela Heat*");
});

test("fields alone still make a description", () => {
  assert.equal(new EmbedBuilder().addFields({ name: "A", value: "b" }).toJSON().description, "**A**\nb");
});

test("a numeric colour becomes hex, and setColor is an alias", () => {
  assert.equal(new EmbedBuilder().setColour(0xff0000).toJSON().colour, "#ff0000");
  assert.equal(new EmbedBuilder().setColor(0x00ff00).toJSON().colour, "#00ff00");
});

test("empty parts are left out, because Stoat rejects empty strings", () => {
  assert.deepEqual(new EmbedBuilder().setTitle("").setDescription("").toJSON(), {});
});

test("too long for Stoat throws a RangeError that names the part", () => {
  assert.throws(() => new EmbedBuilder().setTitle("x".repeat(101)).toJSON(), /title is 101 characters; Stoat allows 100/);
  assert.throws(
    () => new EmbedBuilder().setDescription("x".repeat(1990)).addFields({ name: "Reason", value: "spam" }).toJSON(),
    /description is \d+ characters; Stoat allows 2000/,
  );
});

test("toMessageBody accepts text, an embed, or both", () => {
  const embed = new EmbedBuilder().setTitle("Hi");
  assert.deepEqual(toMessageBody("hello"), { content: "hello" });
  assert.deepEqual(toMessageBody(embed), { embeds: [{ title: "Hi" }] });
  assert.deepEqual(toMessageBody({ content: "hello", embeds: [embed] }), { content: "hello", embeds: [{ title: "Hi" }] });
});

test("more than 5 embeds throws before anything is sent", () => {
  const embeds = Array.from({ length: 6 }, () => new EmbedBuilder().setTitle("x"));
  assert.throws(() => toMessageBody({ embeds }), RangeError);
});

test("channel.send posts an embed", async () => {
  const posted: unknown[] = [];
  const { client } = await connected({
    routes: {
      [`POST /channels/${CHANNEL}/messages`]: (body) => {
        posted.push(body);
        return json(200, { _id: id(30), channel: CHANNEL, author: BOT });
      },
    },
  });
  await client.channels.get(CHANNEL)!.send(new EmbedBuilder().setTitle("Logged"));
  assert.deepEqual(posted, [{ embeds: [{ title: "Logged" }] }]);
});
