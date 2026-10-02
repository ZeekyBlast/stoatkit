import { test } from "node:test";
import assert from "node:assert/strict";
import type { components } from "../src/generated/api.ts";
import { STOAT_API_VERSION } from "../src/generated/version.ts";

type Message = components["schemas"]["Message"];

test("generated types describe a Stoat message", () => {
  // If the generator output stops matching, `npm run typecheck` fails on this line.
  const msg: Message = { _id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", author: "A", channel: "C" };
  assert.equal(msg.channel, "C");
});

test("records which API version the types came from", () => {
  assert.match(STOAT_API_VERSION, /^\d+\.\d+\.\d+$/);
});
