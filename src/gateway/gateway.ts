import { EventEmitter } from "node:events";

/** The parts of the WebSocket API the gateway uses. Node's global WebSocket fits; tests pass a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketConstructor = new (url: string) => SocketLike;

export type GatewayEvent = { type: string; [key: string]: unknown };

export interface GatewayOptions {
  token: string;
  /** The `ws` value from `GET /`. */
  url: string;
  WebSocket?: SocketConstructor;
  /** Default 20 000. */
  heartbeatMs?: number;
  /** Backoff jitter source. Default Math.random. */
  random?: () => number;
  now?: () => number;
}

type GatewayEvents = {
  ready: [GatewayEvent];
  event: [GatewayEvent];
  reconnected: [{ gapMs: number }];
  fatal: [Error];
  error: [Error];
};

/** Stoat error types that mean "this token will never work": stop instead of retrying. */
const FATAL_ERRORS = new Set(["InvalidSession", "Logout"]);
const MAX_BACKOFF_MS = 60_000;

export class Gateway extends EventEmitter<GatewayEvents> {
  readonly #token: string;
  readonly #url: string;
  readonly #WebSocket: SocketConstructor;
  readonly #heartbeatMs: number;
  readonly #random: () => number;
  readonly #now: () => number;

  #socket: SocketLike | null = null;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #alive = false;
  #attempt = 0;
  #disconnectedAt: number | null = null;
  #everReady = false;
  #stopped = false;

  constructor(options: GatewayOptions) {
    super();
    this.#token = options.token;
    this.#url = options.url;
    this.#WebSocket = options.WebSocket ?? (globalThis.WebSocket as unknown as SocketConstructor);
    this.#heartbeatMs = options.heartbeatMs ?? 20_000;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  connect(): void {
    this.#stopped = false;
    this.#open();
  }

  /** Closes on purpose. Never reconnects. */
  close(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    this.#stopHeartbeat();
    this.#socket?.close(1000);
  }

  #open(): void {
    const socket = new this.#WebSocket(`${this.#url}?version=1&format=json`);
    this.#socket = socket;
    // Every handler ignores sockets that are no longer current, so a late close never schedules twice.
    socket.onopen = () => {
      if (socket === this.#socket) socket.send(JSON.stringify({ type: "Authenticate", token: this.#token }));
    };
    socket.onmessage = (ev) => {
      if (socket !== this.#socket) return;
      let frame: GatewayEvent;
      try {
        frame = JSON.parse(String(ev.data)) as GatewayEvent;
      } catch {
        this.emit("error", new Error("Gateway sent a frame that is not JSON"));
        return;
      }
      this.#handle(frame);
    };
    socket.onclose = () => {
      if (socket === this.#socket) this.#lost();
    };
    socket.onerror = () => {}; // a close always follows; reconnecting happens there
  }

  #handle(frame: GatewayEvent): void {
    switch (frame.type) {
      case "Bulk":
        for (const inner of (frame.v as GatewayEvent[] | undefined) ?? []) this.#handle(inner);
        return;
      case "Authenticated":
        this.#startHeartbeat();
        return;
      case "Pong":
        this.#alive = true;
        return;
      case "Ready":
        this.#attempt = 0;
        this.emit("ready", frame);
        if (this.#everReady && this.#disconnectedAt !== null) {
          this.emit("reconnected", { gapMs: this.#now() - this.#disconnectedAt });
        }
        this.#disconnectedAt = null;
        this.#everReady = true;
        return;
      case "Error": {
        // The server source sends { data: { type } }; the docs show { error }.
        const type = (frame.data as { type?: string } | undefined)?.type ?? String(frame.error);
        if (FATAL_ERRORS.has(type)) this.#fail(type);
        else this.emit("error", new Error(`Gateway error: ${type}`));
        return;
      }
      case "Logout":
        this.#fail("Logout");
        return;
      default:
        this.emit("event", frame);
    }
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#alive = true;
    this.#heartbeat = setInterval(() => {
      const socket = this.#socket;
      if (!socket) return;
      if (!this.#alive) {
        // No Pong since the last Ping: treat the connection as dead now rather than waiting for a close handshake.
        this.#lost();
        socket.close(4000);
        return;
      }
      this.#alive = false;
      socket.send(JSON.stringify({ type: "Ping", data: this.#now() }));
    }, this.#heartbeatMs);
  }

  #stopHeartbeat(): void {
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  /** The current socket is gone: forget it and schedule exactly one reconnect. */
  #lost(): void {
    this.#socket = null;
    this.#stopHeartbeat();
    if (this.#stopped) return;
    this.#disconnectedAt ??= this.#now();
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.#attempt) + Math.floor(this.#random() * 1000);
    this.#attempt++;
    this.#reconnectTimer = setTimeout(() => {
      if (!this.#stopped) this.#open();
    }, delay);
  }

  #fail(type: string): void {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    this.#stopHeartbeat();
    const socket = this.#socket;
    this.#socket = null;
    this.emit("fatal", new Error(`Gateway session rejected: ${type}`));
    socket?.close(1000);
  }
}
