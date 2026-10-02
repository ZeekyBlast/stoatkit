import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/util/duration.ts";

test("parses single units", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("10m"), 600_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.equal(parseDuration("1w"), 604_800_000);
});

test("parses combined units", () => {
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration("1d12h"), 129_600_000);
});

test("ignores case and surrounding spaces", () => {
  assert.equal(parseDuration(" 10M "), 600_000);
});

test("returns null for invalid input", () => {
  const bad = ["", "10", "m", "1.5h", "-5m", "10x", "0m", "5m 3s", "abc", "9999999999999999w"];
  for (const input of bad) {
    assert.equal(parseDuration(input), null, `expected null for ${JSON.stringify(input)}`);
  }
});
