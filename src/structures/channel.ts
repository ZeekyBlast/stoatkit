import type { Client } from "../client.ts";
import { toMessageBody, type MessagePayload } from "../embed.ts";
import type { components } from "../generated/api.ts";
import { Message, type RawMessage } from "./message.ts";
import type { Server } from "./server.ts";

export type RawChannel = components["schemas"]["Channel"];
type PartialChannel = components["schemas"]["PartialChannel"];
type OverrideField = components["schemas"]["OverrideField"];

/** Which raw field each `clear` entry of a ChannelUpdate empties. */
const CLEARABLE: Record<string, string> = {
  Description: "description",
  Icon: "icon",
  DefaultPermissions: "default_permissions",
  Slowmode: "slowmode",
};

export class Channel {
  readonly #client: Client;
  readonly #raw: RawChannel;
  readonly id: string;
  /** Stoat's `channel_type`, e.g. "TextChannel" or "DirectMessage". */
  readonly type: string;
  readonly name: string | undefined;
  readonly serverId: string | undefined;
  /** The channel's own allow/deny for everyone, if set. */
  readonly defaultPermissions: OverrideField | null;
  /** Allow/deny per role id. */
  readonly rolePermissions: Record<string, OverrideField>;
  /** Seconds between messages per member. 0 means off. */
  readonly slowmode: number;

  constructor(client: Client, raw: RawChannel) {
    this.#client = client;
    this.#raw = raw;
    this.id = raw._id;
    this.type = raw.channel_type;
    this.name = "name" in raw ? raw.name : undefined;
    this.serverId = "server" in raw ? raw.server : undefined;
    this.defaultPermissions = "default_permissions" in raw ? (raw.default_permissions ?? null) : null;
    this.rolePermissions = "role_permissions" in raw ? (raw.role_permissions ?? {}) : {};
    this.slowmode = "slowmode" in raw ? (raw.slowmode ?? 0) : 0;
  }

  get server(): Server | undefined {
    return this.serverId ? this.#client.servers.get(this.serverId) : undefined;
  }

  async send(payload: MessagePayload): Promise<Message> {
    const raw = await this.#client.rest.request<RawMessage>("POST", `/channels/${this.id}/messages`, toMessageBody(payload));
    return new Message(this.#client, raw);
  }

  /** Sets slowmode in seconds (Stoat allows up to 6 hours). 0 turns it off. Returns the updated channel. */
  async setSlowmode(seconds: number, reason?: string): Promise<Channel> {
    const body = seconds > 0 ? { slowmode: seconds } : { remove: ["Slowmode"] };
    const raw = await this.#client.rest.request<RawChannel>("PATCH", `/channels/${this.id}`, body, { reason });
    return new Channel(this.#client, raw);
  }

  /** Deletes 1 to 100 messages at once. Stoat only allows messages from the past week. */
  async bulkDelete(ids: string[], reason?: string): Promise<void> {
    await this.#client.rest.request("DELETE", `/channels/${this.id}/messages/bulk`, { ids }, { reason });
  }

  /** A copy with a ChannelUpdate's changes applied. */
  withUpdate(data: PartialChannel, clear: string[] = []): Channel {
    const next: Record<string, unknown> = { ...this.#raw, ...data };
    for (const field of clear) if (CLEARABLE[field]) delete next[CLEARABLE[field]];
    return new Channel(this.#client, next as RawChannel);
  }
}
