import { EventEmitter } from "node:events";
import { MessageCache } from "./cache/messages.ts";
import { Gateway, type GatewayEvent, type SocketConstructor } from "./gateway/gateway.ts";
import type { components } from "./generated/api.ts";
import { Rest } from "./rest/rest.ts";
import { Channel } from "./structures/channel.ts";
import { Message, type RawMessage } from "./structures/message.ts";
import { User } from "./structures/user.ts";

type RawUser = components["schemas"]["User"];
type RawChannel = components["schemas"]["Channel"];

export interface ClientOptions {
  token: string;
  /** Default `https://api.stoat.chat`. */
  baseUrl?: string;
  /** Messages kept per channel so deletes and edits can hand over the original. Default 200. */
  messageCacheSize?: number;
  fetch?: typeof globalThis.fetch;
  WebSocket?: SocketConstructor;
}

/** What `messageDelete` gives you: the full message if it was cached, otherwise just its ids. */
export type DeletedMessage = Message | { id: string; channelId: string };

type ClientEvents = {
  ready: [];
  messageCreate: [Message];
  messageUpdate: [before: Message | null, after: Message];
  messageDelete: [DeletedMessage];
  messageDeleteBulk: [{ channelId: string; ids: string[]; messages: Message[] }];
  reconnected: [{ gapMs: number }];
  error: [unknown];
  fatal: [Error];
};

export class Client extends EventEmitter<ClientEvents> {
  readonly rest: Rest;
  user: User | null = null;
  readonly users = new Map<string, User>();
  readonly channels = new Map<string, Channel>();
  readonly messages: MessageCache;
  readonly #token: string;
  readonly #WebSocket: SocketConstructor | undefined;
  #gateway: Gateway | null = null;

  constructor(options: ClientOptions) {
    // captureRejections: a rejected promise from an async listener becomes an "error" event.
    super({ captureRejections: true });
    this.#token = options.token;
    this.#WebSocket = options.WebSocket;
    this.rest = new Rest({ token: options.token, baseUrl: options.baseUrl, fetch: options.fetch });
    this.messages = new MessageCache(options.messageCacheSize ?? 200);
  }

  /** Finds the gateway, loads the bot user, connects, and resolves once Stoat sends Ready. */
  async login(): Promise<void> {
    const config = await this.rest.request<components["schemas"]["RevoltConfig"]>("GET", "/");
    this.user = new User(await this.rest.request<RawUser>("GET", "/users/@me"));

    const gateway = new Gateway({ token: this.#token, url: config.ws, WebSocket: this.#WebSocket });
    this.#gateway = gateway;
    gateway.on("ready", (frame) => this.#onReady(frame));
    gateway.on("event", (frame) => this.#onEvent(frame));
    gateway.on("reconnected", (info) => this.#emit("reconnected", info));
    gateway.on("error", (err) => this.#report(err));
    gateway.on("fatal", (err) => this.#emit("fatal", err));

    const ready = new Promise<void>((resolve, reject) => {
      const onReady = () => {
        gateway.off("fatal", onFatal);
        resolve();
      };
      const onFatal = (err: Error) => {
        gateway.off("ready", onReady);
        reject(err);
      };
      gateway.once("ready", onReady);
      gateway.once("fatal", onFatal);
    });
    gateway.connect();
    return ready;
  }

  /** Disconnects for good. */
  destroy(): void {
    this.#gateway?.close();
  }

  #onReady(frame: GatewayEvent): void {
    for (const raw of (frame.users as RawUser[] | undefined) ?? []) this.users.set(raw._id, new User(raw));
    for (const raw of (frame.channels as RawChannel[] | undefined) ?? []) this.channels.set(raw._id, new Channel(this, raw));
    this.#emit("ready");
  }

  #onEvent(frame: GatewayEvent): void {
    switch (frame.type) {
      case "Message": {
        const raw = frame as unknown as RawMessage;
        if (raw.user) this.users.set(raw.user._id, new User(raw.user));
        const message = new Message(this, raw);
        this.messages.set(message);
        this.#emit("messageCreate", message);
        return;
      }
      case "MessageUpdate":
        void this.#onMessageUpdate(frame as unknown as MessageUpdateFrame);
        return;
      case "MessageDelete": {
        const { id, channel } = frame as unknown as { id: string; channel: string };
        this.#emit("messageDelete", this.messages.delete(channel, id) ?? { id, channelId: channel });
        return;
      }
      case "BulkMessageDelete": {
        const { channel, ids } = frame as unknown as { channel: string; ids: string[] };
        const messages = ids.map((id) => this.messages.delete(channel, id)).filter((m) => m !== undefined);
        this.#emit("messageDeleteBulk", { channelId: channel, ids, messages });
        return;
      }
      case "ChannelCreate": {
        const raw = frame as unknown as RawChannel;
        this.channels.set(raw._id, new Channel(this, raw));
        return;
      }
      case "ChannelDelete":
        this.channels.delete(frame.id as string);
        return;
      // Servers, members and roles arrive in Plan 2.
    }
  }

  async #onMessageUpdate({ id, channel, data }: MessageUpdateFrame): Promise<void> {
    const before = this.messages.get(channel, id) ?? null;
    let after: Message;
    if (before) {
      after = before.withUpdate(data);
    } else {
      try {
        after = new Message(this, await this.rest.request<RawMessage>("GET", `/channels/${channel}/messages/${id}`));
      } catch (err) {
        this.#report(err);
        return;
      }
    }
    this.messages.set(after);
    this.#emit("messageUpdate", before, after);
  }

  /** Emits without letting a throwing listener break the gateway loop. */
  #emit<K extends keyof ClientEvents>(event: K, ...args: ClientEvents[K]): void {
    try {
      (this.emit as (event: K, ...args: ClientEvents[K]) => boolean)(event, ...args);
    } catch (err) {
      this.#report(err);
    }
  }

  #report(err: unknown): void {
    if (this.listenerCount("error") > 0) this.emit("error", err);
    else console.error(err);
  }
}

type MessageUpdateFrame = { id: string; channel: string; data: { content?: string | null; edited?: string | null } };
