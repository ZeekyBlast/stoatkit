import type { Client } from "../client.ts";
import type { components } from "../generated/api.ts";
import { ulidToDate } from "../util/ulid.ts";
import type { Channel } from "./channel.ts";
import type { User } from "./user.ts";

export type RawMessage = components["schemas"]["Message"];

export class Message {
  readonly #client: Client;
  readonly #raw: RawMessage;
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly content: string;
  readonly editedAt: Date | null;

  constructor(client: Client, raw: RawMessage) {
    this.#client = client;
    this.#raw = raw;
    this.id = raw._id;
    this.channelId = raw.channel;
    this.authorId = raw.author;
    this.content = raw.content ?? "";
    this.editedAt = raw.edited ? new Date(raw.edited) : null;
  }

  get createdAt(): Date {
    return ulidToDate(this.id);
  }

  get author(): User | undefined {
    return this.#client.users.get(this.authorId);
  }

  get channel(): Channel | undefined {
    return this.#client.channels.get(this.channelId);
  }

  async reply(content: string): Promise<Message> {
    const raw = await this.#client.rest.request<RawMessage>("POST", `/channels/${this.channelId}/messages`, {
      content,
      replies: [{ id: this.id, mention: false }],
    });
    return new Message(this.#client, raw);
  }

  async edit(content: string): Promise<Message> {
    const raw = await this.#client.rest.request<RawMessage>("PATCH", `/channels/${this.channelId}/messages/${this.id}`, {
      content,
    });
    return new Message(this.#client, raw);
  }

  async delete(): Promise<void> {
    await this.#client.rest.request("DELETE", `/channels/${this.channelId}/messages/${this.id}`);
  }

  /** A copy with a MessageUpdate's changes applied. The original stays as the "before". */
  withUpdate(data: { content?: string | null; edited?: string | null }): Message {
    const next: RawMessage = { ...this.#raw };
    if (data.content !== undefined) next.content = data.content;
    if (data.edited !== undefined) next.edited = data.edited;
    return new Message(this.#client, next);
  }
}
