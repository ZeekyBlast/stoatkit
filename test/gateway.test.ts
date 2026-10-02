import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Gateway } from "../src/gateway/gateway.ts";
import { FakeSocket } from "./helpers/socket.ts";

let now = 0;

beforeEach(() => {
  FakeSocket.instances = [];
  now = 0;
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
});

afterEach(() => mock.timers.reset());

/** Move both the fake clock and the fake timers forward. */
function tick(ms: number) {
  now += ms;
  mock.timers.tick(ms);
}

function makeGateway() {
  const gw = new Gateway({ token: "t0k", url: "wss://events.test", WebSocket: FakeSocket, random: () => 0, now: () => now });
  const seen: Array<[string, unknown]> = [];
  gw.on("ready", (x) => seen.push(["ready", x]));
  gw.on("event", (x) => seen.push(["event", x]));
  gw.on("reconnected", (x) => seen.push(["reconnected", x]));
  gw.on("fatal", (x) => seen.push(["fatal", x]));
  gw.on("error", (x) => seen.push(["error", x]));
  return { gw, seen, socket: (i = -1) => FakeSocket.instances.at(i)! };
}

function handshake(s: FakeSocket, ready: object = { users: [] }) {
  s.open();
  s.receive({ type: "Authenticated" });
  s.receive({ type: "Ready", ...ready });
}

test("connects with protocol params and authenticates on open", () => {
  const { gw, socket } = makeGateway();
  gw.connect();
  assert.equal(socket().url, "wss://events.test?version=1&format=json");
  socket().open();
  assert.deepEqual(socket().sent, [{ type: "Authenticate", token: "t0k" }]);
});

test("emits ready and unpacks Bulk", () => {
  const { gw, seen, socket } = makeGateway();
  gw.connect();
  handshake(socket(), { users: [{ _id: "U1" }] });
  socket().receive({
    type: "Bulk",
    v: [
      { type: "MessageDelete", id: "M1", channel: "C1" },
      { type: "ChannelDelete", id: "C2" },
    ],
  });
  assert.deepEqual(seen, [
    ["ready", { type: "Ready", users: [{ _id: "U1" }] }],
    ["event", { type: "MessageDelete", id: "M1", channel: "C1" }],
    ["event", { type: "ChannelDelete", id: "C2" }],
  ]);
});

test("pings every 20s while pongs come back", () => {
  const { gw, socket } = makeGateway();
  gw.connect();
  handshake(socket());
  tick(20_000);
  assert.deepEqual(socket().sent.at(-1), { type: "Ping", data: 20_000 });
  socket().receive({ type: "Pong", data: 20_000 });
  tick(20_000);
  assert.deepEqual(socket().sent.at(-1), { type: "Ping", data: 40_000 });
  assert.equal(FakeSocket.instances.length, 1);
});

test("a missed pong reconnects exactly once, then reports the gap", () => {
  const { gw, seen, socket } = makeGateway();
  gw.connect();
  handshake(socket());
  tick(20_000); // ping sent, no pong comes back
  tick(20_000); // connection counted as dead: close it and schedule a reconnect
  assert.equal(socket(0).readyState, 3);
  tick(1_000); // backoff of 1s (random = 0)
  assert.equal(FakeSocket.instances.length, 2, "exactly one new socket");
  handshake(socket(1));
  assert.deepEqual(seen.find(([name]) => name === "reconnected"), ["reconnected", { gapMs: 1_000 }]);
  assert.equal(seen.filter(([name]) => name === "ready").length, 2);
});

test("backoff doubles up to 60s", () => {
  const { gw, socket } = makeGateway();
  gw.connect();
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
    const before = FakeSocket.instances.length;
    socket().drop();
    tick(delay - 1);
    assert.equal(FakeSocket.instances.length, before, `reconnected before ${delay}ms`);
    tick(1);
    assert.equal(FakeSocket.instances.length, before + 1, `no reconnect after ${delay}ms`);
  }
});

test("an invalid session is fatal and never retried", () => {
  const { gw, seen, socket } = makeGateway();
  gw.connect();
  socket().open();
  socket().receive({ type: "Error", data: { type: "InvalidSession" } });
  assert.equal(seen[0]![0], "fatal");
  assert.match((seen[0]![1] as Error).message, /InvalidSession/);
  assert.equal(socket().readyState, 3);
  tick(120_000);
  assert.equal(FakeSocket.instances.length, 1);
});

test("the legacy error shape is understood too", () => {
  const { gw, seen, socket } = makeGateway();
  gw.connect();
  socket().open();
  socket().receive({ type: "Error", error: "InvalidSession" });
  assert.equal(seen[0]![0], "fatal");
});

test("a malformed frame is reported, not thrown", () => {
  const { gw, seen, socket } = makeGateway();
  gw.connect();
  socket().open();
  socket().onmessage!({ data: "not json" });
  assert.equal(seen[0]![0], "error");
});

test("close() stops for good", () => {
  const { gw, socket } = makeGateway();
  gw.connect();
  handshake(socket());
  gw.close();
  tick(120_000);
  assert.equal(FakeSocket.instances.length, 1);
});

test("a connection that never authenticates is dropped and retried", () => {
  const { gw, socket } = makeGateway();
  gw.connect();
  socket().open();
  tick(19_999);
  assert.equal(FakeSocket.instances.length, 1);
  tick(1); // no Authenticated within one heartbeat interval
  assert.equal(socket(0).readyState, 3);
  tick(1_000);
  assert.equal(FakeSocket.instances.length, 2);
});
