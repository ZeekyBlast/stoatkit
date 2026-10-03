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

/** Each recorded frame type and the client event it must produce. */
const EXPECTED_EVENTS: Record<string, string[]> = {
  Message: ["messageCreate"],
  MessageUpdate: ["messageUpdate"],
  MessageDelete: ["messageDelete"],
  ServerMemberJoin: ["memberJoin"],
  ServerMemberLeave: ["memberLeave"],
  ServerMemberUpdate: ["memberUpdate"],
  ServerRoleUpdate: ["roleCreate", "roleUpdate"],
  ServerRoleDelete: ["roleDelete"],
  ChannelCreate: ["channelCreate"],
  ChannelUpdate: ["channelUpdate"],
  ChannelDelete: ["channelDelete"],
};

/** What the recording must contain, so the test covers more than messages. */
const MUST_RECORD = ["Message", "MessageDelete", "ServerMemberJoin", "ServerMemberLeave", "ServerRoleUpdate", "ServerRoleDelete"];

test("a recorded real session replays without errors", { skip: missing }, async () => {
  const frames: Frame[] = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const ready = frames.find((f) => f.type === "Ready");
  assert.ok(ready, "fixture has no Ready frame");
  const me = ((ready.users ?? []) as Array<{ _id: string; bot?: unknown }>).find((u) => u.bot);
  assert.ok(me, "fixture's Ready has no bot user");
  for (const type of MUST_RECORD) assert.ok(frames.some((f) => f.type === type), `record a ${type} (see scripts/record.ts)`);

  // Answer the lookups the client makes for people it hasn't seen: joiners' users, updated members.
  const routes: Record<string, () => Response> = {
    "GET /": () => json(200, { ws: "wss://events.test" }),
    "GET /users/@me": () => json(200, me),
  };
  for (const f of frames) {
    if (f.type === "ServerMemberJoin") {
      const user = f.user as string;
      routes[`GET /users/${user}`] = () => json(200, { _id: user, username: "recorded", discriminator: "0000" });
    }
    if (f.type === "ServerMemberUpdate") {
      const key = f.id as { server: string; user: string };
      routes[`GET /servers/${key.server}/members/${key.user}`] = () =>
        json(200, { _id: key, joined_at: "2026-01-01T00:00:00.000Z" });
    }
  }
  const { fetch } = routeFetch(routes);
  FakeSocket.instances = [];
  const client = new Client({ token: "t", baseUrl: "https://api.test", fetch, WebSocket: FakeSocket, auditLookup: false });
  after(() => client.destroy());

  const errors: unknown[] = [];
  const created = new Set<string>();
  const deleted: unknown[] = [];
  const fired = new Map<string, number>();
  client.on("error", (e) => errors.push(e));
  client.on("messageCreate", (m) => created.add(m.id));
  client.on("messageDelete", (m) => deleted.push(m));
  for (const event of new Set(Object.values(EXPECTED_EVENTS).flat())) {
    // Typed as "ready" only to satisfy the compiler: this listener ignores its arguments, so any event fits.
    client.on(event as "ready", () => fired.set(event, (fired.get(event) ?? 0) + 1));
  }

  const loggedIn = client.login();
  await waitFor(() => FakeSocket.instances.length === 1);
  const socket = FakeSocket.instances[0]!;
  socket.open();
  socket.receive({ type: "Authenticated" });
  for (const frame of frames) socket.receive(frame);
  await loggedIn;

  const recorded = new Set(frames.map((f) => f.type));
  for (const [type, events] of Object.entries(EXPECTED_EVENTS)) {
    if (!recorded.has(type)) continue;
    await waitFor(() => events.some((e) => (fired.get(e) ?? 0) > 0)).catch(() => {
      assert.fail(`${type} was recorded but no ${events.join("/")} event fired`);
    });
  }
  assert.deepEqual(errors, []);
  for (const f of frames.filter((f) => f.type === "Message")) assert.ok(created.has(f._id as string), `no messageCreate for ${String(f._id)}`);
  assert.ok(deleted.some((m) => m instanceof Message), "record deleting a message you sent during the recording");
});
