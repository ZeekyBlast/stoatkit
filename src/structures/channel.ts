import type { Client } from "../client.ts";
import type { components } from "../generated/api.ts";
import { Message, type RawMessage } from "./message.ts";

type RawChannel = components["schemas"]["Channel"];

export class Channel {
  readonly #client: Client;
  readonly id: string;
  /** Stoat's `channel_type`, e.g. "TextChannel" or "DirectMessage". */
  readonly type: string;
  readonly name: string | undefined;
  readonly serverId: string | undefined;

  constructor(client: Client, raw: RawChannel) {
    this.#client = client;
    this.id = raw._id;
    this.type = raw.channel_type;
    this.name = "name" in raw ? raw.name : undefined;
    this.serverId = "server" in raw ? raw.server : undefined;
  }

  async send(content: string): Promise<Message> {
    const raw = await this.#client.rest.request<RawMessage>("POST", `/channels/${this.id}/messages`, { content });
    return new Message(this.#client, raw);
  }
}
