import { Client, type ClientOptions } from "../../src/client.ts";
import { FakeSocket } from "./socket.ts";
import { routeFetch, json } from "./fetch.ts";
import { waitFor } from "./wait.ts";

/** Valid ULIDs that all decode to 2026-10-02T12:00:00.000Z. */
export const id = (n: number) => "01M3Y7RKG0" + String(n).padStart(16, "0");
export const BOT = id(1);
export const USER = id(2);
export const CHANNEL = id(3);
export const SERVER = id(4);

export const BOT_USER = { _id: BOT, username: "vela", discriminator: "0001", bot: { owner: USER } };
export const READY = {
  type: "Ready",
  users: [BOT_USER, { _id: USER, username: "zeeky", discriminator: "1234", display_name: "Zeeky" }],
  channels: [{ _id: CHANNEL, channel_type: "TextChannel", name: "general", server: SERVER }],
  servers: [],
  members: [],
};

export const msg = (n: number, content: string, author = USER) => ({ type: "Message", _id: id(n), channel: CHANNEL, author, content });

const clients: Client[] = [];

/** Disconnects every client `connected()` made. Call it from `afterEach`. */
export function destroyClients(): void {
  for (const c of clients.splice(0)) c.destroy();
}

export interface ConnectOptions {
  /** Extra fake REST routes, keyed "METHOD /path". */
  routes?: Record<string, (body: unknown) => Response>;
  /** Replaces the default Ready frame. */
  ready?: object;
  /** Set false to test what happens with no "error" listener. */
  errorListener?: boolean;
  /** Any other Client options. */
  options?: Partial<ClientOptions>;
}

/** A logged-in Client on a FakeSocket, plus the socket, the REST calls made and the errors reported. */
export async function connected({ routes, ready = READY, errorListener = true, options = {} }: ConnectOptions = {}) {
  FakeSocket.instances = [];
  const { fetch, calls } = routeFetch({
    "GET /": () => json(200, { revolt: "0.15.7", ws: "wss://events.test" }),
    "GET /users/@me": () => json(200, BOT_USER),
    ...routes,
  });
  const client = new Client({ token: "t0k", baseUrl: "https://api.test", fetch, WebSocket: FakeSocket, ...options });
  clients.push(client);
  const errors: unknown[] = [];
  if (errorListener) client.on("error", (e) => errors.push(e));
  const loggedIn = client.login();
  await waitFor(() => FakeSocket.instances.length === 1);
  const socket = FakeSocket.instances[0]!;
  socket.open();
  socket.receive({ type: "Authenticated" });
  socket.receive(ready);
  await loggedIn;
  return { client, socket, calls, errors };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A valid ULID whose time is `ms`, for entries that must look fresh or stale. */
export function idAt(ms: number, n = 0): string {
  let time = "";
  for (let i = 0; i < 10; i++, ms = Math.floor(ms / 32)) time = CROCKFORD[ms % 32] + time;
  return time + String(n).padStart(16, "0");
}
