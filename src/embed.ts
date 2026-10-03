import type { components } from "./generated/api.ts";

export type SendableEmbed = components["schemas"]["SendableEmbed"];

export interface EmbedField {
  name: string;
  value: string;
}

/** Stoat's limits, from its embed validation. */
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 2000;
const MAX_URL = 256;
const MAX_EMBEDS = 5;

/**
 * Builds a Stoat embed with a discord.js-like API. Stoat embeds have no fields or footer,
 * so those are written into the description as markdown.
 */
export class EmbedBuilder {
  #title: string | undefined;
  #description: string | undefined;
  #colour: string | undefined;
  #url: string | undefined;
  #iconUrl: string | undefined;
  #fields: EmbedField[] = [];
  #footer: string | undefined;

  setTitle(title: string): this {
    this.#title = title;
    return this;
  }

  setDescription(description: string): this {
    this.#description = description;
    return this;
  }

  /** Any CSS colour, or a number like 0xff0000. */
  setColour(colour: string | number): this {
    this.#colour = typeof colour === "number" ? `#${colour.toString(16).padStart(6, "0")}` : colour;
    return this;
  }

  setColor(color: string | number): this {
    return this.setColour(color);
  }

  setURL(url: string): this {
    this.#url = url;
    return this;
  }

  setIconURL(url: string): this {
    this.#iconUrl = url;
    return this;
  }

  addFields(...fields: EmbedField[]): this {
    this.#fields.push(...fields);
    return this;
  }

  setFooter(text: string): this {
    this.#footer = text;
    return this;
  }

  /** The body Stoat expects. Throws RangeError if Stoat would refuse it. */
  toJSON(): SendableEmbed {
    const parts = [
      this.#description,
      ...this.#fields.map((field) => `**${field.name}**\n${field.value}`),
      this.#footer && `*${this.#footer}*`,
    ].filter((part) => part);
    const description = parts.join("\n\n");

    check("title", this.#title, MAX_TITLE);
    check("description", description, MAX_DESCRIPTION);
    check("url", this.#url, MAX_URL);
    check("icon URL", this.#iconUrl, MAX_URL);

    const embed: SendableEmbed = {};
    // Stoat rejects empty strings, so empty parts are left out instead of sent.
    if (this.#title) embed.title = this.#title;
    if (description) embed.description = description;
    if (this.#colour) embed.colour = this.#colour;
    if (this.#url) embed.url = this.#url;
    if (this.#iconUrl) embed.icon_url = this.#iconUrl;
    return embed;
  }
}

function check(name: string, value: string | undefined, max: number): void {
  if (value && value.length > max) throw new RangeError(`Embed ${name} is ${value.length} characters; Stoat allows ${max}`);
}

/** What `send`, `reply` and `edit` accept: text, one embed, or both. */
export type MessagePayload = string | EmbedBuilder | { content?: string; embeds?: EmbedBuilder[] };

/** Turns a MessagePayload into the JSON body for Stoat. */
export function toMessageBody(payload: MessagePayload): { content?: string; embeds?: SendableEmbed[] } {
  if (typeof payload === "string") return { content: payload };
  if (payload instanceof EmbedBuilder) return { embeds: [payload.toJSON()] };
  if (payload.embeds && payload.embeds.length > MAX_EMBEDS) {
    throw new RangeError(`A message can have ${MAX_EMBEDS} embeds; got ${payload.embeds.length}`);
  }
  const body: { content?: string; embeds?: SendableEmbed[] } = {};
  if (payload.content !== undefined) body.content = payload.content;
  if (payload.embeds) body.embeds = payload.embeds.map((embed) => embed.toJSON());
  return body;
}
