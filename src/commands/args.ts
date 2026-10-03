import type { Client } from "../client.ts";
import type { PermissionName } from "../permissions.ts";
import { StoatAPIError } from "../rest/errors.ts";
import type { Channel } from "../structures/channel.ts";
import type { Member } from "../structures/member.ts";
import type { Role } from "../structures/role.ts";
import type { User } from "../structures/user.ts";
import { parseDuration } from "../util/duration.ts";
import { parseMention, type MentionType } from "../util/mentions.ts";
import { isUlid } from "../util/ulid.ts";

export type ArgType = "member" | "user" | "channel" | "role" | "duration" | "number" | "string" | "rest";

/** Every argument type, so specs from outside TypeScript can be checked. */
export const ARG_TYPES: Record<ArgType, true> = {
  member: true,
  user: true,
  channel: true,
  role: true,
  duration: true,
  number: true,
  string: true,
  rest: true,
};

/** Argument name → type, in the order users type them. A trailing `?` makes one optional. */
export type ArgSpec = Record<string, ArgType | `${ArgType}?`>;

type ArgValue<T> = T extends "member"
  ? Member
  : T extends "user"
    ? User
    : T extends "channel"
      ? Channel
      : T extends "role"
        ? Role
        : T extends "duration" | "number"
          ? number
          : string;

/** The `args` object a command's `run` receives. Durations are milliseconds. */
export type ParsedArgs<S extends ArgSpec> = {
  [K in keyof S]: S[K] extends `${infer T}?` ? ArgValue<T> | undefined : ArgValue<S[K]>;
};

export type CommandErrorCode = "MissingArgument" | "InvalidArgument" | "MissingPermissions";

/** A problem with how a command was used. The command framework replies with it instead of reporting it. */
export class CommandError extends Error {
  readonly code: CommandErrorCode;
  /** The argument's name, for MissingArgument and InvalidArgument. */
  readonly arg: string | undefined;
  /** The argument's type, for InvalidArgument. */
  readonly argType: ArgType | undefined;
  /** What the user typed, for InvalidArgument. */
  readonly value: string | undefined;
  /** What the user lacks, for MissingPermissions. */
  readonly permissions: PermissionName[];

  constructor(
    code: CommandErrorCode,
    details: { arg?: string; argType?: ArgType; value?: string; permissions?: PermissionName[] } = {},
  ) {
    super(details.arg ? `${code}: ${details.arg}` : code);
    this.name = "CommandError";
    this.code = code;
    this.arg = details.arg;
    this.argType = details.argType;
    this.value = details.value;
    this.permissions = details.permissions ?? [];
  }
}

export interface Token {
  text: string;
  /** Where the token starts in the input, so `rest` can take the raw remainder. */
  start: number;
}

/** Splits on whitespace; `"double quotes"` keep words together. An unclosed quote is just a character. */
export function tokenize(input: string): Token[] {
  return [...input.matchAll(/"([^"]*)"|\S+/g)].map((m) => ({ text: m[1] ?? m[0], start: m.index }));
}

/** `<target> <duration> [reason...]` */
export function usage(spec: ArgSpec): string {
  return Object.entries(spec)
    .map(([name, type]) => {
      const label = type.startsWith("rest") ? `${name}...` : name;
      return type.endsWith("?") ? `[${label}]` : `<${label}>`;
    })
    .join(" ");
}

/** Parses `input` against `spec`. Throws CommandError for missing or invalid arguments. */
export async function parseArgs<S extends ArgSpec>(
  spec: S,
  input: string,
  scope: { client: Client; serverId: string },
): Promise<ParsedArgs<S>> {
  const tokens = tokenize(input);
  const args: Record<string, unknown> = {};
  let next = 0;
  for (const [name, declared] of Object.entries(spec)) {
    const optional = declared.endsWith("?");
    const type = (optional ? declared.slice(0, -1) : declared) as ArgType;
    const token = tokens[next];
    if (!token) {
      if (!optional) throw new CommandError("MissingArgument", { arg: name });
      args[name] = undefined;
      continue;
    }
    if (type === "rest") {
      args[name] = input.slice(token.start).trim();
      next = tokens.length;
      continue;
    }
    next++;
    const value = await resolve(type, token.text, scope);
    if (value === undefined) throw new CommandError("InvalidArgument", { arg: name, argType: type, value: token.text });
    args[name] = value;
  }
  return args as ParsedArgs<S>;
}

/** The value for one token, or undefined if it doesn't fit the type. */
async function resolve(type: ArgType, text: string, { client, serverId }: { client: Client; serverId: string }) {
  switch (type) {
    case "member": {
      const id = idFrom(text, "user");
      return id ? notFoundAsUndefined(client.fetchMember(serverId, id)) : undefined;
    }
    case "user": {
      const id = idFrom(text, "user");
      return id ? notFoundAsUndefined(client.fetchUser(id)) : undefined;
    }
    case "channel": {
      const id = idFrom(text, "channel");
      const channel = id ? client.channels.get(id) : undefined;
      return channel?.serverId === serverId ? channel : undefined;
    }
    case "role": {
      const roles = client.servers.get(serverId)?.roles;
      const id = idFrom(text, "role");
      if (id) return roles?.get(id);
      const name = text.toLowerCase();
      return [...(roles?.values() ?? [])].find((role) => role.name.toLowerCase() === name);
    }
    case "duration":
      return parseDuration(text) ?? undefined;
    case "number": {
      const n = Number(text);
      return text.trim() !== "" && Number.isFinite(n) ? n : undefined;
    }
    default:
      return text;
  }
}

/** The id in a mention of the right kind, or a bare id. */
function idFrom(text: string, type: MentionType): string | undefined {
  const mention = parseMention(text);
  if (mention) return mention.type === type ? mention.id : undefined;
  return isUlid(text) ? text.toUpperCase() : undefined;
}

/** "Not in this server" is a bad argument, not a crash. Any other failure still throws. */
async function notFoundAsUndefined<T>(lookup: Promise<T>): Promise<T | undefined> {
  try {
    return await lookup;
  } catch (err) {
    if (err instanceof StoatAPIError && err.status === 404) return undefined;
    throw err;
  }
}
