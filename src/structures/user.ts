import type { Client } from "../client.ts";
import type { components } from "../generated/api.ts";
import { ulidToDate } from "../util/ulid.ts";
import { Channel, type RawChannel } from "./channel.ts";

type RawUser = components["schemas"]["User"];

export class User {
  readonly #client: Client;
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly bot: boolean;

  constructor(client: Client, raw: RawUser) {
    this.#client = client;
    this.id = raw._id;
    this.username = raw.username;
    this.displayName = raw.display_name ?? raw.username;
    this.bot = raw.bot != null;
  }

  get createdAt(): Date {
    return ulidToDate(this.id);
  }

  /** Opens (or reuses) the DM channel with this user. Fails if they don't share a server with the bot. */
  async dm(): Promise<Channel> {
    const channel = new Channel(this.#client, await this.#client.rest.request<RawChannel>("GET", `/users/${this.id}/dm`));
    this.#client.channels.set(channel.id, channel);
    return channel;
  }
}
