import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { MemberCache } from "./cache/members.ts";
import { CommandRegistry, type BeforeCommand, type CommandErrorFormatter, type PrefixOption } from "./commands/registry.ts";
import { MessageCache } from "./cache/messages.ts";
import { Gateway, type GatewayEvent, type SocketConstructor } from "./gateway/gateway.ts";
import type { components } from "./generated/api.ts";
import { isCommand, isEvent, loadModules, type EventDefinition, type LoadResult } from "./loader.ts";
import { missingPermissions } from "./permissions.ts";
import { StoatAPIError } from "./rest/errors.ts";
import { Rest } from "./rest/rest.ts";
import { Channel } from "./structures/channel.ts";
import { Member, type RawMember } from "./structures/member.ts";
import { Message, type RawMessage } from "./structures/message.ts";
import { Role, type RawRole } from "./structures/role.ts";
import { Server, type RawServer } from "./structures/server.ts";
import { User } from "./structures/user.ts";
import { ulidToDate } from "./util/ulid.ts";

type RawUser = components["schemas"]["User"];
type RawChannel = components["schemas"]["Channel"];
type Schemas = components["schemas"];

export interface ClientOptions {
  token: string;
  /** Default `https://api.stoat.chat`. */
  baseUrl?: string;
  /** Messages kept per channel so deletes and edits can hand over the original. Default 200. */
  messageCacheSize?: number;
  /**
   * After a kick, ban, role delete or channel delete, read the audit log to find who did it and emit
   * `auditLogEntry`. Each lookup spends a request from the server's shared rate-limit bucket. Default true.
   */
  auditLookup?: boolean;
  /** How long to wait before each audit-log attempt. Stoat writes the entry after the event, so wait first. Default [1000, 3000]. */
  auditDelaysMs?: number[];
  /** Command prefix: fixed, or looked up per server. Default "!". */
  prefix?: PrefixOption;
  /** Replaces the default replies to failed commands. */
  formatCommandError?: CommandErrorFormatter;
  /** Runs before every command, ahead of permission checks. Return false to stop it. For cooldowns, blocklists and the like. */
  beforeCommand?: BeforeCommand;
  fetch?: typeof globalThis.fetch;
  WebSocket?: SocketConstructor;
}

/** Why a member left: on their own, kicked, or banned. */
export type LeaveReason = "Leave" | "Kick" | "Ban";

/** The audit-log actions stoatkit looks up by itself. */
export type AuditAction = "MemberKick" | "BanCreate" | "RoleDelete" | "ChannelDelete";

export interface AuditLogEntry {
  serverId: string;
  action: AuditAction;
  /** The kicked or banned user, or the deleted role or channel. */
  targetId: string;
  /** Who did it. null when no matching entry turned up, or the bot lacks ViewAuditLogs. */
  executorId: string | null;
  reason: string | null;
}

/** Every event name, so names from outside TypeScript (a .js event file) can be checked. Record keeps it complete. */
const EVENT_NAMES: Record<keyof ClientEvents, true> = {
  ready: true,
  messageCreate: true,
  messageUpdate: true,
  messageDelete: true,
  messageDeleteBulk: true,
  channelCreate: true,
  channelUpdate: true,
  channelDelete: true,
  memberJoin: true,
  memberLeave: true,
  memberUpdate: true,
  roleCreate: true,
  roleUpdate: true,
  roleDelete: true,
  auditLogEntry: true,
  reconnected: true,
  error: true,
  fatal: true,
};

/** An audit entry counts if it is at most this much older than the event (Stoat's clock may differ from ours). */
const AUDIT_WINDOW_MS = 30_000;

/** What `messageDelete` gives you: the full message if it was cached, otherwise just its ids. */
/** What an invite code points at. */
export interface InviteInfo {
  code: string;
  type: "Server" | "Group";
  serverId: string | null;
  serverName: string | null;
  channelId: string;
}

export type DeletedMessage = Message | { id: string; channelId: string };

/** Every event the client emits, with its arguments. */
export type ClientEvents = {
  ready: [];
  messageCreate: [Message];
  messageUpdate: [before: Message | null, after: Message];
  messageDelete: [DeletedMessage];
  messageDeleteBulk: [{ channelId: string; ids: string[]; messages: Message[] }];
  channelCreate: [Channel];
  channelUpdate: [before: Channel, after: Channel];
  channelDelete: [Channel | { id: string }];
  memberJoin: [Member];
  memberLeave: [member: Member | { id: string; serverId: string }, reason: LeaveReason];
  memberUpdate: [before: Member | null, after: Member];
  roleCreate: [Role];
  roleUpdate: [before: Role, after: Role];
  roleDelete: [Role | { id: string; serverId: string }];
  auditLogEntry: [AuditLogEntry];
  reconnected: [{ gapMs: number }];
  error: [unknown];
  fatal: [Error];
};

export class Client extends EventEmitter<ClientEvents> {
  readonly rest: Rest;
  user: User | null = null;
  readonly users = new Map<string, User>();
  readonly servers = new Map<string, Server>();
  readonly channels = new Map<string, Channel>();
  readonly members = new MemberCache();
  readonly commands: CommandRegistry;
  readonly messages: MessageCache;
  readonly #token: string;
  readonly #WebSocket: SocketConstructor | undefined;
  readonly #auditLookup: boolean;
  readonly #auditDelaysMs: number[];
  #gateway: Gateway | null = null;

  constructor(options: ClientOptions) {
    // captureRejections: a rejected promise from an async listener becomes an "error" event.
    super({ captureRejections: true });
    this.#token = options.token;
    this.#WebSocket = options.WebSocket;
    this.rest = new Rest({ token: options.token, baseUrl: options.baseUrl, fetch: options.fetch });
    this.messages = new MessageCache(options.messageCacheSize ?? 200);
    this.commands = new CommandRegistry(
      this,
      { prefix: options.prefix, formatError: options.formatCommandError, beforeCommand: options.beforeCommand },
      (err) => this.#report(err),
    );
    this.#auditLookup = options.auditLookup ?? true;
    this.#auditDelaysMs = options.auditDelaysMs ?? [1000, 3000];
  }

  /** Finds the gateway, loads the bot user, connects, and resolves once Stoat sends Ready. */
  async login(): Promise<void> {
    const config = await this.rest.request<components["schemas"]["RevoltConfig"]>("GET", "/");
    this.user = new User(this, await this.rest.request<RawUser>("GET", "/users/@me"));

    const gateway = new Gateway({ token: this.#token, url: config.ws, WebSocket: this.#WebSocket });
    this.#gateway = gateway;
    gateway.on("ready", (frame) => this.#guard(() => this.#onReady(frame)));
    gateway.on("event", (frame) => this.#guard(() => this.#onEvent(frame)));
    gateway.on("reconnected", (info) => this.#emit("reconnected", info));
    gateway.on("error", (err) => this.#report(err));
    gateway.on("fatal", (err) => this.#emit("fatal", err));

    const ready = new Promise<void>((resolve, reject) => {
      const onReady = () => {
        gateway.off("fatal", onFatal);
        resolve();
      };
      const onFatal = (err: Error) => {
        gateway.off("ready", onReady);
        reject(err);
      };
      gateway.once("ready", onReady);
      gateway.once("fatal", onFatal);
    });
    gateway.connect();
    return ready;
  }

  /**
   * Imports every command file under `dir` and adds its default export (made with `defineCommand`).
   * Pass `new URL("./commands", import.meta.url)` so the path works from both src/ and a build.
   */
  async loadCommands(dir: string | URL): Promise<LoadResult> {
    return loadModules(
      dir,
      (value) => {
        if (!isCommand(value)) throw new TypeError("its default export isn't a command; wrap it in defineCommand()");
        this.commands.add(value);
      },
      (err) => this.#report(err),
    );
  }

  /** Imports every event file under `dir` and listens with its default export (made with `defineEvent`). */
  async loadEvents(dir: string | URL): Promise<LoadResult> {
    return loadModules(
      dir,
      (value, file) => {
        if (!isEvent(value)) throw new TypeError("its default export isn't an event; wrap it in defineEvent()");
        this.addEvent(value, file);
      },
      (err) => this.#report(err),
    );
  }

  /**
   * Listens with an event definition (from `defineEvent`): `run` gets the event's arguments, then the client.
   * A failure is reported on `error` under `label`, e.g. the file it came from. For your own loaders.
   */
  addEvent<K extends keyof ClientEvents>(event: EventDefinition<K>, label: string = event.name): void {
    // A .js file or an unchecked .ts file can misspell the name; without this it would load and never fire.
    if (!Object.hasOwn(EVENT_NAMES, event.name)) throw new TypeError(`Unknown event "${event.name}"`);
    const fail = (err: unknown) => {
      const failure = new Error(`${label} (${event.name}) failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      // An error listener's own failure goes to the console: reporting it would call the same listener again, forever.
      if (event.name === "error") console.error(failure);
      else this.#report(failure);
    };
    const listener = (...args: unknown[]) => {
      try {
        const result = (event.run as (...a: unknown[]) => unknown)(...args, this);
        if (result instanceof Promise) result.catch(fail);
      } catch (err) {
        fail(err);
      }
    };
    if (event.once) this.once(event.name, listener as never);
    else this.on(event.name, listener as never);
  }

  /** A member from the cache, or from Stoat if it isn't cached. Throws StoatAPIError (404) if they aren't in the server. */
  async fetchMember(serverId: string, userId: string): Promise<Member> {
    const cached = this.members.get(serverId, userId);
    if (cached) return cached;
    const member = new Member(this, await this.rest.request<RawMember>("GET", `/servers/${serverId}/members/${userId}`));
    this.members.set(member);
    return member;
  }

  /** A user from the cache, or from Stoat if it isn't cached. */
  async fetchUser(userId: string): Promise<User> {
    const cached = this.users.get(userId);
    if (cached) return cached;
    const user = new User(this, await this.rest.request<RawUser>("GET", `/users/${userId}`));
    this.users.set(user.id, user);
    return user;
  }

  /** What an invite code points at. null when Stoat doesn't know the code. */
  async fetchInvite(code: string): Promise<InviteInfo | null> {
    try {
      const raw = await this.rest.request<Schemas["InviteResponse"]>("GET", `/invites/${encodeURIComponent(code)}`);
      return raw.type === "Server"
        ? { code: raw.code, type: "Server", serverId: raw.server_id, serverName: raw.server_name, channelId: raw.channel_id }
        : { code: raw.code, type: "Group", serverId: null, serverName: null, channelId: raw.channel_id };
    } catch (err) {
      if (err instanceof StoatAPIError && err.status === 404) return null;
      throw err;
    }
  }

  /** Disconnects for good. */
  destroy(): void {
    this.#gateway?.close();
  }

  #onReady(frame: GatewayEvent): void {
    for (const raw of (frame.users as RawUser[] | undefined) ?? []) this.users.set(raw._id, new User(this, raw));
    for (const raw of (frame.servers as RawServer[] | undefined) ?? []) this.servers.set(raw._id, new Server(this, raw));
    // For bots, Ready only lists the bot's own memberships. Everyone else is cached as they show up.
    for (const raw of (frame.members as RawMember[] | undefined) ?? []) this.members.set(new Member(this, raw));
    for (const raw of (frame.channels as RawChannel[] | undefined) ?? []) this.channels.set(raw._id, new Channel(this, raw));
    this.#emit("ready");
  }

  #onEvent(frame: GatewayEvent): void {
    switch (frame.type) {
      case "Message": {
        const raw = frame as unknown as RawMessage;
        if (raw.user) this.users.set(raw.user._id, new User(this, raw.user));
        if (raw.member) this.members.set(new Member(this, raw.member));
        const message = new Message(this, raw);
        this.messages.set(message);
        this.#emit("messageCreate", message);
        this.commands.handle(message).catch((err: unknown) => this.#report(err));
        return;
      }
      case "MessageUpdate":
        this.#onMessageUpdate(frame as unknown as MessageUpdateFrame).catch((err: unknown) => this.#report(err));
        return;
      case "MessageDelete": {
        const { id, channel } = frame as unknown as { id: string; channel: string };
        this.#emit("messageDelete", this.messages.delete(channel, id) ?? { id, channelId: channel });
        return;
      }
      case "BulkMessageDelete": {
        const { channel, ids } = frame as unknown as { channel: string; ids: string[] };
        const messages = ids.map((id) => this.messages.delete(channel, id)).filter((m) => m !== undefined);
        this.#emit("messageDeleteBulk", { channelId: channel, ids, messages });
        return;
      }
      case "ServerCreate": {
        const { server, channels } = frame as unknown as { server: RawServer; channels?: RawChannel[] };
        this.servers.set(server._id, new Server(this, server));
        for (const raw of channels ?? []) this.channels.set(raw._id, new Channel(this, raw));
        // Stoat subscribes the bot to a server only after this event, so the bot never sees its own join.
        // Seed a role-less member, as Stoat itself does, so server.me works straight away.
        if (this.user && !this.members.get(server._id, this.user.id)) {
          this.members.set(new Member(this, { _id: { server: server._id, user: this.user.id }, joined_at: new Date().toISOString() }));
        }
        return;
      }
      case "ServerUpdate": {
        const { id, data } = frame as unknown as { id: string; data: Schemas["PartialServer"] };
        const server = this.servers.get(id);
        if (server) this.servers.set(id, server.withUpdate(data));
        return;
      }
      case "ServerDelete":
        this.#forgetServer(frame.id as string);
        return;
      case "ServerMemberJoin": {
        // A join carries no user object. Fetching one per join would queue a raid behind the rate limit,
        // so listeners that need the name call client.fetchUser(member.id) themselves.
        const member = new Member(this, (frame as unknown as { member: RawMember }).member);
        this.members.set(member);
        this.#emit("memberJoin", member);
        return;
      }
      case "ServerMemberLeave": {
        const { id, user, reason } = frame as unknown as { id: string; user: string; reason: LeaveReason };
        const member = this.members.delete(id, user);
        this.#emit("memberLeave", member ?? { id: user, serverId: id }, reason);
        if (user === this.user?.id) this.#forgetServer(id);
        else if (reason === "Kick") this.#lookupAudit(id, "MemberKick", user);
        else if (reason === "Ban") this.#lookupAudit(id, "BanCreate", user);
        return;
      }
      case "ServerMemberUpdate":
        this.#onMemberUpdate(frame as unknown as MemberUpdateFrame).catch((err: unknown) => this.#report(err));
        return;
      case "ServerRoleUpdate": {
        const { id, role_id, data, clear } = frame as unknown as RoleUpdateFrame;
        const roles = this.servers.get(id)?.roles;
        if (!roles) return;
        const before = roles.get(role_id);
        // Stoat has no ServerRoleCreate: a new role arrives as an update for an id we don't know yet.
        const after = before ? before.withUpdate(data, clear) : new Role(id, role_id, data as RawRole);
        roles.set(role_id, after);
        if (before) this.#emit("roleUpdate", before, after);
        else this.#emit("roleCreate", after);
        return;
      }
      case "ServerRoleDelete": {
        const { id, role_id } = frame as unknown as { id: string; role_id: string };
        const roles = this.servers.get(id)?.roles;
        const role = roles?.get(role_id);
        roles?.delete(role_id);
        this.#emit("roleDelete", role ?? { id: role_id, serverId: id });
        this.#lookupAudit(id, "RoleDelete", role_id);
        return;
      }
      case "ServerRoleRanksUpdate": {
        // `ranks` lists role ids top to bottom; each role's new rank is its index.
        const { id, ranks } = frame as unknown as { id: string; ranks: string[] };
        const roles = this.servers.get(id)?.roles;
        if (!roles) return;
        for (const [rank, roleId] of ranks.entries()) {
          const role = roles.get(roleId);
          if (role) roles.set(roleId, role.withUpdate({ rank }));
        }
        return;
      }
      case "ChannelCreate": {
        const channel = new Channel(this, frame as unknown as RawChannel);
        this.channels.set(channel.id, channel);
        this.#emit("channelCreate", channel);
        return;
      }
      case "ChannelUpdate": {
        const { id, data, clear } = frame as unknown as ChannelUpdateFrame;
        const before = this.channels.get(id);
        if (!before) return; // every server channel arrives in Ready; an unknown one is a DM or group we don't track
        const after = before.withUpdate(data, clear);
        this.channels.set(id, after);
        this.#emit("channelUpdate", before, after);
        return;
      }
      case "ChannelDelete": {
        const id = frame.id as string;
        const channel = this.channels.get(id);
        this.channels.delete(id);
        this.#emit("channelDelete", channel ?? { id });
        if (channel?.serverId) this.#lookupAudit(channel.serverId, "ChannelDelete", id);
        return;
      }
    }
  }

  /** Finds who did `action` to `targetId`, then emits `auditLogEntry` exactly once, found or not. */
  #lookupAudit(serverId: string, action: AuditAction, targetId: string): void {
    if (!this.#auditLookup) return;
    const since = Date.now() - AUDIT_WINDOW_MS;
    this.#findAuditEntry(serverId, action, targetId, since)
      .catch((err: unknown) => {
        this.#report(err);
        return null;
      })
      .then((entry) => {
        this.#emit("auditLogEntry", { serverId, action, targetId, executorId: entry?.user ?? null, reason: entry?.reason ?? null });
      });
  }

  async #findAuditEntry(serverId: string, action: AuditAction, targetId: string, since: number) {
    const me = this.servers.get(serverId)?.me;
    if (!me || missingPermissions(me.permissions, ["ViewAuditLogs"]).length > 0) return null;
    for (const delay of this.#auditDelaysMs) {
      // unref: a pending lookup never keeps the process alive
      if (delay > 0) await sleep(delay, undefined, { ref: false });
      const page = await this.rest.request<Schemas["AuditLogQueryResponse"]>(
        "GET",
        `/servers/${serverId}/audit_logs?type=${action}&limit=10`,
      );
      for (const raw of page.users) if (!this.users.has(raw._id)) this.users.set(raw._id, new User(this, raw));
      // Newest first. An older entry for the same target (kicked last week, rejoined) must not be blamed.
      const entry = page.audit_logs.find(
        (e) => e.action.type === action && auditTarget(e.action) === targetId && ulidToDate(e._id).getTime() >= since,
      );
      if (entry) return entry;
    }
    return null;
  }

  /** The bot left or the server was deleted: drop it and everything in it. */
  #forgetServer(serverId: string): void {
    this.servers.delete(serverId);
    this.members.deleteServer(serverId);
    for (const [id, channel] of this.channels) if (channel.serverId === serverId) this.channels.delete(id);
  }

  async #onMessageUpdate({ id, channel, data }: MessageUpdateFrame): Promise<void> {
    const before = this.messages.get(channel, id) ?? null;
    let after: Message;
    if (before) {
      after = before.withUpdate(data);
    } else {
      try {
        after = new Message(this, await this.rest.request<RawMessage>("GET", `/channels/${channel}/messages/${id}`));
      } catch (err) {
        this.#report(err);
        return;
      }
    }
    this.messages.set(after);
    this.#emit("messageUpdate", before, after);
  }

  async #onMemberUpdate({ id, data, clear }: MemberUpdateFrame): Promise<void> {
    const before = this.members.get(id.server, id.user) ?? null;
    let after: Member;
    if (before) {
      after = before.withUpdate(data, clear);
    } else {
      // ponytail: the fetch spends the shared server bucket; build from the partial data if that ever slows moderation
      try {
        after = await this.fetchMember(id.server, id.user);
      } catch (err) {
        this.#report(err);
        return;
      }
    }
    this.members.set(after);
    this.#emit("memberUpdate", before, after);
  }

  /** Called by EventEmitter (captureRejections) when an async listener rejects. Never crashes the process. */
  [EventEmitter.captureRejectionSymbol](err: unknown, event?: string | symbol): void {
    // An async error listener that rejects goes to the console: reporting it would call the same listener again, forever.
    if (event === "error") console.error(err);
    else this.#report(err);
  }

  /** Emits without letting a throwing listener break the gateway loop. */
  #emit<K extends keyof ClientEvents>(event: K, ...args: ClientEvents[K]): void {
    try {
      (this.emit as (event: K, ...args: ClientEvents[K]) => boolean)(event, ...args);
    } catch (err) {
      this.#report(err);
    }
  }

  #report(err: unknown): void {
    if (this.listenerCount("error") === 0) {
      console.error(err);
      return;
    }
    try {
      this.emit("error", err);
    } catch (listenerErr) {
      console.error(listenerErr); // an error listener that throws must neither crash the bot nor loop
    }
  }

  /** Runs one gateway frame's handling. A frame we can't make sense of is reported; throwing here would crash the process. */
  #guard(handle: () => void): void {
    try {
      handle();
    } catch (err) {
      this.#report(err);
    }
  }
}

function auditTarget(action: Schemas["AuditLogEntryAction"]): string | undefined {
  switch (action.type) {
    case "MemberKick":
    case "BanCreate":
      return action.user;
    case "RoleDelete":
      return action.role;
    case "ChannelDelete":
      return action.channel;
    default:
      return undefined;
  }
}

type MemberUpdateFrame = { id: { server: string; user: string }; data: Schemas["PartialMember"]; clear?: string[] };
type RoleUpdateFrame = { id: string; role_id: string; data: Schemas["PartialRole"]; clear?: string[] };
type ChannelUpdateFrame = { id: string; data: Schemas["PartialChannel"]; clear?: string[] };
type MessageUpdateFrame = { id: string; channel: string; data: { content?: string | null; edited?: string | null } };
