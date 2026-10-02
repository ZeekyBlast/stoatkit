import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Client } from "../src/client.ts";
import { Message } from "../src/structures/message.ts";
import { FakeSocket } from "./helpers/socket.ts";
import { routeFetch, json } from "./helpers/fetch.ts";
import { waitFor } from "./helpers/wait.ts";

type Frame = { type: string; [key: string]: unknown };
const FIXTURE = new URL("./fixtures/session.json", import.meta.url);
const missing = existsSync(FIXTURE) ? false : "no recording yet: run `node --env-file=.env scripts/record.ts`";

test("a recorded real session replays without errors", { skip: missing }, async () => {
  const frames: Frame[] = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const ready = frames.find((f) => f.type === "Ready");
  assert.ok(ready, "fixture has no Ready frame");
  const me = ((ready.users ?? []) as Array<{ _id: string; bot?: unknown }>).find((u) => u.bot);
  assert.ok(me, "fixture's Ready has no bot user");

  const { fetch } = routeFetch({
    "GET /": () => json(200, { ws: "wss://events.test" }),
    "GET /users/@me": () => json(200, me),
  });
  FakeSocket.instances = [];
  const client = new Client({ token: "t", baseUrl: "https://api.test", fetch, WebSocket: FakeSocket });
  after(() => client.destroy());

  const errors: unknown[] = [];
  const created = new Set<string>();
  const deleted: unknown[] = [];
  client.on("error", (e) => errors.push(e));
  client.on("messageCreate", (m) => created.add(m.id));
  client.on("messageDelete", (m) => deleted.push(m));

  const loggedIn = client.login();
  await waitFor(() => FakeSocket.instances.length === 1);
  const socket = FakeSocket.instances[0]!;
  socket.open();
  socket.receive({ type: "Authenticated" });
  for (const frame of frames) socket.receive(frame);
  await loggedIn;

  assert.deepEqual(errors, []);
  const messageFrames = frames.filter((f) => f.type === "Message");
  assert.ok(messageFrames.length > 0, "record at least one message");
  for (const f of messageFrames) assert.ok(created.has(f._id as string), `no messageCreate for ${String(f._id)}`);
  assert.ok(deleted.some((m) => m instanceof Message), "record deleting a message you sent during the recording");
});
