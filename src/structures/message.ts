import type { Client } from "../client.ts";
import { toMessageBody, type MessagePayload } from "../embed.ts";
import type { components } from "../generated/api.ts";
import { ulidToDate } from "../util/ulid.ts";
import type { Channel } from "./channel.ts";
import type { Member } from "./member.ts";
import type { User } from "./user.ts";

export type RawMessage = components["schemas"]["Message"];

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export class Message {
  readonly #client: Client;
  readonly #raw: RawMessage;
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly content: string;
  readonly editedAt: Date | null;
  readonly attachments: Attachment[];
  /** Users mentioned in the message. */
  readonly mentionIds: string[];
  readonly roleMentionIds: string[];
  /** A Stoat system message (joins, pins, ...), not something a member typed. */
  readonly isSystem: boolean;
  readonly isWebhook: boolean;
  /** Emoji (a unicode emoji or a custom emoji id) to the ids of the users who reacted with it. */
  readonly reactions: ReadonlyMap<string, readonly string[]>;

  constructor(client: Client, raw: RawMessage) {
    this.#client = client;
    this.#raw = raw;
    this.id = raw._id;
    this.channelId = raw.channel;
    this.authorId = raw.author;
    this.content = raw.content ?? "";
    this.editedAt = raw.edited ? new Date(raw.edited) : null;
    this.attachments = (raw.attachments ?? []).map((f) => ({ id: f._id, filename: f.filename, contentType: f.content_type, size: f.size }));
    this.mentionIds = raw.mentions ?? [];
    this.roleMentionIds = raw.role_mentions ?? [];
    this.isSystem = raw.system != null;
    this.isWebhook = raw.webhook != null;
    this.reactions = new Map(Object.entries(raw.reactions ?? {}));
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

  /** The author's cached member in this channel's server. */
  get member(): Member | undefined {
    const serverId = this.channel?.serverId;
    return serverId ? this.#client.members.get(serverId, this.authorId) : undefined;
  }

  async reply(payload: MessagePayload): Promise<Message> {
    const raw = await this.#client.rest.request<RawMessage>("POST", `/channels/${this.channelId}/messages`, {
      ...toMessageBody(payload),
      replies: [{ id: this.id, mention: false }],
    });
    return new Message(this.#client, raw);
  }

  async edit(payload: MessagePayload): Promise<Message> {
    const path = `/channels/${this.channelId}/messages/${this.id}`;
    const raw = await this.#client.rest.request<RawMessage>("PATCH", path, toMessageBody(payload));
    return new Message(this.#client, raw);
  }

  async delete(): Promise<void> {
    await this.#client.rest.request("DELETE", `/channels/${this.channelId}/messages/${this.id}`);
  }

  /** React with a unicode emoji or a custom emoji id. */
  async react(emoji: string): Promise<void> {
    await this.#client.rest.request("PUT", this.#reactionPath(emoji));
  }

  /** Remove the bot's reaction, or `userId`'s (needs Manage Messages). */
  async unreact(emoji: string, userId?: string): Promise<void> {
    await this.#client.rest.request("DELETE", this.#reactionPath(emoji) + (userId ? `?user_id=${userId}` : ""));
  }

  /** Remove everyone's reactions with `emoji`, or every reaction when no emoji is given. Needs Manage Messages. */
  async clearReactions(emoji?: string): Promise<void> {
    const path = emoji ? `${this.#reactionPath(emoji)}?remove_all=true` : `/channels/${this.channelId}/messages/${this.id}/reactions`;
    await this.#client.rest.request("DELETE", path);
  }

  #reactionPath(emoji: string): string {
    return `/channels/${this.channelId}/messages/${this.id}/reactions/${encodeURIComponent(emoji)}`;
  }

  /** A copy with a MessageUpdate's changes applied. The original stays as the "before". */
  withUpdate(data: { content?: string | null; edited?: string | null; reactions?: Record<string, string[]> }): Message {
    const next: RawMessage = { ...this.#raw };
    if (data.content !== undefined) next.content = data.content;
    if (data.edited !== undefined) next.edited = data.edited;
    if (data.reactions !== undefined) next.reactions = data.reactions;
    return new Message(this.#client, next);
  }

  /** A copy with `emoji`'s users replaced. No users removes the emoji. */
  withReaction(emoji: string, users: string[]): Message {
    const reactions = { ...this.#raw.reactions, [emoji]: users };
    if (users.length === 0) delete reactions[emoji];
    return new Message(this.#client, { ...this.#raw, reactions });
  }
}
