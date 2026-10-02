import type { Message } from "../structures/message.ts";

/** Keeps the newest `perChannel` messages of each channel, so deletes and edits can hand over the original. */
export class MessageCache {
  readonly #perChannel: number;
  readonly #channels = new Map<string, Map<string, Message>>();

  constructor(perChannel: number) {
    this.#perChannel = perChannel;
  }

  set(message: Message): void {
    let channel = this.#channels.get(message.channelId);
    if (!channel) this.#channels.set(message.channelId, (channel = new Map()));
    channel.delete(message.id); // re-insert so it counts as newest
    channel.set(message.id, message);
    if (channel.size > this.#perChannel) channel.delete(channel.keys().next().value!);
  }

  get(channelId: string, id: string): Message | undefined {
    return this.#channels.get(channelId)?.get(id);
  }

  delete(channelId: string, id: string): Message | undefined {
    const channel = this.#channels.get(channelId);
    const message = channel?.get(id);
    channel?.delete(id);
    return message;
  }
}
