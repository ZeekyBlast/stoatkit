import { test } from "node:test";
import assert from "node:assert/strict";
import { ulidToDate, isUlid } from "../src/util/ulid.ts";

test("decodes the timestamp from a ULID", () => {
  assert.equal(ulidToDate("01ARZ3NDEKTSV4RRFFQ69G5FAV").getTime(), 1469922850259);
});

test("is case-insensitive", () => {
  assert.equal(ulidToDate("01arz3ndektsv4rrffq69g5fav").getTime(), 1469922850259);
});

test("decodes a 2026 id", () => {
  assert.equal(ulidToDate("01M3Y7RKG00000000000000000").toISOString(), "2026-10-02T12:00:00.000Z");
});

test("rejects the wrong length", () => {
  assert.throws(() => ulidToDate("01ARZ3NDEK"), TypeError);
});

test("rejects characters outside Crockford base32", () => {
  // U is not in the alphabet (neither are I, L, O)
  assert.throws(() => ulidToDate("01ARZ3NDEUTSV4RRFFQ69G5FAV"), TypeError);
});

test("rejects timestamps beyond 48 bits", () => {
  assert.throws(() => ulidToDate("80000000000000000000000000"), TypeError);
});

test("isUlid", () => {
  assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"), true);
  assert.equal(isUlid("hello"), false);
});
