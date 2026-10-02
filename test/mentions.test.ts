import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMention, userMention, roleMention, channelMention } from "../src/util/mentions.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

test("parses user, role and channel mentions", () => {
  assert.deepEqual(parseMention(`<@${ID}>`), { type: "user", id: ID });
  assert.deepEqual(parseMention(`<%${ID}>`), { type: "role", id: ID });
  assert.deepEqual(parseMention(`<#${ID}>`), { type: "channel", id: ID });
});

test("returns null for anything that is not exactly one mention", () => {
  assert.equal(parseMention(ID), null);              // a raw id is not a mention
  assert.equal(parseMention(`<@${ID}> hi`), null);   // extra text
  assert.equal(parseMention("<@abc>"), null);        // not a ULID
  assert.equal(parseMention(`<!${ID}>`), null);      // unknown sigil
  assert.equal(parseMention(""), null);
});

test("formats mentions", () => {
  assert.equal(userMention(ID), `<@${ID}>`);
  assert.equal(roleMention(ID), `<%${ID}>`);
  assert.equal(channelMention(ID), `<#${ID}>`);
});

test("round-trips", () => {
  assert.deepEqual(parseMention(roleMention(ID)), { type: "role", id: ID });
});
