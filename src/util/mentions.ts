import { isUlid } from "./ulid.ts";

export type MentionType = "user" | "role" | "channel";

const SIGILS: Record<string, MentionType> = { "@": "user", "%": "role", "#": "channel" };
const MENTION_RE = /^<([@%#])(.+)>$/;

/** Parses a whole string that is exactly one Stoat mention: `<@user>`, `<%role>` or `<#channel>`. */
export function parseMention(text: string): { type: MentionType; id: string } | null {
  const match = MENTION_RE.exec(text);
  if (!match) return null;
  const [, sigil, id] = match;
  const type = SIGILS[sigil!];
  return type && isUlid(id!) ? { type, id: id! } : null;
}

export const userMention = (id: string): string => `<@${id}>`;
export const roleMention = (id: string): string => `<%${id}>`;
export const channelMention = (id: string): string => `<#${id}>`;
