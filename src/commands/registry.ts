import type { Client } from "../client.ts";
import type { MessagePayload } from "../embed.ts";
import { missingPermissions, type PermissionName } from "../permissions.ts";
import { StoatAPIError } from "../rest/errors.ts";
import type { Channel } from "../structures/channel.ts";
import type { Member } from "../structures/member.ts";
import type { Message } from "../structures/message.ts";
import type { Server } from "../structures/server.ts";
import { ARG_TYPES, CommandError, parseArgs, usage, type ArgSpec, type ParsedArgs } from "./args.ts";

export interface CommandContext {
  client: Client;
  message: Message;
  server: Server;
  channel: Channel;
  /** Whoever ran the command. */
  member: Member;
  /** The prefix used in this server. */
  prefix: string;
  command: Command;
  reply(payload: MessagePayload): Promise<Message>;
}

export interface Command<S extends ArgSpec = ArgSpec> {
  name: string;
  aliases?: string[];
  /** For help. */
  description?: string;
  /** For help, to group commands. */
  category?: string;
  args?: S;
  /** Checked in the channel the command was used in. */
  permissions?: PermissionName[];
  run(ctx: CommandContext, args: ParsedArgs<S>): unknown;
}

/** A fixed prefix, or one per server (from your database, say). */
export type PrefixOption = string | ((serverId: string) => string | Promise<string>);

/** Turns a failed command into a reply. Return null to stay quiet. */
export type CommandErrorFormatter = (error: unknown, ctx: CommandContext) => MessagePayload | null;

/** Runs before every command, ahead of permission checks. Return false to stop it (reply yourself if you want). */
export type BeforeCommand = (ctx: CommandContext) => unknown;

export interface CommandOptions {
  /** Default "!". */
  prefix?: PrefixOption;
  /** Replaces the default replies (see `defaultErrorReply`). */
  formatError?: CommandErrorFormatter;
  beforeCommand?: BeforeCommand;
}

/** The default replies. Errors it doesn't recognise are also reported on the client's `error` event. */
export function defaultErrorReply(error: unknown, ctx: CommandContext): string {
  if (error instanceof CommandError) {
    switch (error.code) {
      case "MissingArgument":
        return `Missing \`${error.arg}\`. Usage: \`${ctx.prefix}${ctx.command.name} ${usage(ctx.command.args ?? {})}\``;
      case "InvalidArgument":
        return `\`${shown(error.value ?? "")}\` isn't a valid ${error.argType} for \`${error.arg}\`.`;
      case "MissingPermissions":
        return `You need ${error.permissions.join(", ")} to use this.`;
    }
  }
  if (error instanceof StoatAPIError) {
    if (error.type === "MissingPermission") return `I'm missing ${(error.details as { permission?: string }).permission ?? "a permission"}.`;
    if (error.type === "NotElevated") return "They rank at or above me.";
    if (error.type === "IsElevated") return "They can't be timed out: they have TimeoutMembers.";
  }
  return "Something went wrong running that command.";
}

/**
 * User input repeated in a reply. A backtick would end the code span and let `@everyone` or a role mention
 * through, so backticks become quotes; long input is cut so the reply stays short.
 */
function shown(text: string): string {
  const safe = text.replaceAll("`", "'");
  return safe.length > 100 ? `${safe.slice(0, 100)}…` : safe;
}

/** Errors the default reply already explains. Anything else is a bug worth reporting. */
function expected(error: unknown): boolean {
  return (
    error instanceof CommandError ||
    (error instanceof StoatAPIError && ["MissingPermission", "NotElevated", "IsElevated"].includes(error.type))
  );
}

export class CommandRegistry {
  readonly #client: Client;
  readonly #prefix: PrefixOption;
  readonly #formatError: CommandErrorFormatter;
  readonly #beforeCommand: BeforeCommand | undefined;
  readonly #report: (err: unknown) => void;
  /** Every name and alias, lowercased, pointing at its command. */
  readonly #byName = new Map<string, Command>();
  readonly #commands: Command[] = [];

  constructor(client: Client, options: CommandOptions, report: (err: unknown) => void) {
    this.#client = client;
    this.#prefix = options.prefix ?? "!";
    this.#formatError = options.formatError ?? defaultErrorReply;
    this.#beforeCommand = options.beforeCommand;
    this.#report = report;
  }

  /** Registers a command. `args` types flow into `run`. */
  add<const S extends ArgSpec>(command: Command<S>): this {
    const types = Object.values(command.args ?? {});
    for (const type of types) {
      if (!Object.hasOwn(ARG_TYPES, type.replace(/\?$/, ""))) throw new TypeError(`${command.name}: unknown argument type "${type}"`);
    }
    if (types.slice(0, -1).some((type) => type.startsWith("rest"))) {
      throw new TypeError(`${command.name}: a "rest" argument must be the last one`);
    }
    const names = [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
    for (const name of names) if (this.#byName.has(name)) throw new TypeError(`Command name "${name}" is already taken`);
    // Stored as the general Command type. Safe: run only ever gets args parsed from this command's own spec.
    const general = command as unknown as Command;
    for (const name of names) this.#byName.set(name, general);
    this.#commands.push(general);
    return this;
  }

  /** By name or alias, any case. */
  get(name: string): Command | undefined {
    return this.#byName.get(name.toLowerCase());
  }

  /** In the order they were added. */
  list(): Command[] {
    return [...this.#commands];
  }

  /** `timeout <target> <length> [reason...]` */
  usage(command: Command, prefix = ""): string {
    return `${prefix}${command.name} ${usage(command.args ?? {})}`.trim();
  }

  /** Runs the command in `message`, if there is one. The client calls this for every new message. */
  async handle(message: Message): Promise<void> {
    if (this.#commands.length === 0) return;
    const client = this.#client;
    const channel = message.channel;
    const server = channel?.server;
    if (!channel || !server) return; // commands only run in servers
    if (message.authorId === client.user?.id || message.author?.bot) return;

    const prefix = typeof this.#prefix === "string" ? this.#prefix : await this.#prefix(server.id);
    if (!prefix || !message.content.startsWith(prefix)) return;
    const body = message.content.slice(prefix.length);
    const name = /^\S+/.exec(body)?.[0];
    const command = name ? this.get(name) : undefined;
    if (!name || !command) return;

    const member = await client.fetchMember(server.id, message.authorId);
    const ctx: CommandContext = { client, message, server, channel, member, prefix, command, reply: (p) => message.reply(p) };
    try {
      if ((await this.#beforeCommand?.(ctx)) === false) return;
      const missing = missingPermissions(member.permissionsIn(channel), command.permissions ?? []);
      if (missing.length > 0) throw new CommandError("MissingPermissions", { permissions: missing });
      const args = await parseArgs(command.args ?? {}, body.slice(name.length), { client, serverId: server.id });
      await command.run(ctx, args);
    } catch (err) {
      if (!expected(err)) this.#report(err);
      const reply = this.#formatError(err, ctx);
      if (reply !== null) await ctx.reply(reply);
    }
  }
}
