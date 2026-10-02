import assert from "node:assert/strict";

/** Let pending promises settle until `check()` is true. Fails after `rounds` turns of the event loop. */
export async function waitFor(check: () => boolean, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), "condition never became true");
}
