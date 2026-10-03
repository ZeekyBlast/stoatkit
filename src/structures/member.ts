import type { Client } from "../client.ts";
import type { components } from "../generated/api.ts";
import { channelPermissions, serverPermissions, type RankedOverride, type ServerPermissionInput } from "../permissions.ts";
import type { Channel } from "./channel.ts";
import type { Role } from "./role.ts";
import type { Server } from "./server.ts";
import type { User } from "./user.ts";

export type RawMember = components["schemas"]["Member"];

export interface BanOptions {
  /** Shown in the ban list and the audit log. Kept exactly, emoji and all: it goes in the body, not a header. */
  reason?: string;
  /** Also delete the user's messages from this many seconds back. */
  deleteMessageSeconds?: number;
}
type PartialMember = components["schemas"]["PartialMember"];

/** Which raw field each `clear` entry of a ServerMemberUpdate empties. */
const CLEARABLE: Record<string, string> = { Nickname: "nickname", Avatar: "avatar", Roles: "roles", Timeout: "timeout" };

export class Member {
  readonly #client: Client;
  readonly #raw: RawMember;
  /** The user's id. */
  readonly id: string;
  readonly serverId: string;
  readonly joinedAt: Date;
  readonly nickname: string | null;
  readonly roleIds: string[];
  readonly timeoutUntil: Date | null;

  constructor(client: Client, raw: RawMember) {
    this.#client = client;
    this.#raw = raw;
    this.id = raw._id.user;
    this.serverId = raw._id.server;
    this.joinedAt = new Date(raw.joined_at);
    this.nickname = raw.nickname ?? null;
    this.roleIds = raw.roles ?? [];
    this.timeoutUntil = raw.timeout ? new Date(raw.timeout) : null;
  }

  get user(): User | undefined {
    return this.#client.users.get(this.id);
  }

  get server(): Server | undefined {
    return this.#client.servers.get(this.serverId);
  }

  get displayName(): string {
    return this.nickname ?? this.user?.displayName ?? this.id;
  }

  /** The member's roles that the server still has, highest first. */
  get roles(): Role[] {
    const roles = this.server?.roles;
    if (!roles) return [];
    return this.roleIds
      .map((id) => roles.get(id))
      .filter((role) => role !== undefined)
      .sort((a, b) => a.rank - b.rank);
  }

  /** The rank of the highest role. Lower is higher; Infinity means no roles. */
  get rank(): number {
    return Math.min(Infinity, ...this.roles.map((role) => role.rank));
  }

  get isOwner(): boolean {
    return this.server?.ownerId === this.id;
  }

  isTimedOut(now = Date.now()): boolean {
    return this.timeoutUntil !== null && this.timeoutUntil.getTime() > now;
  }

  /** Server-wide permissions, as a bigint. Test them with `missingPermissions`. */
  get permissions(): bigint {
    return serverPermissions(this.#permissionInput());
  }

  /** Permissions in one channel: the server's, then the channel's overrides. */
  permissionsIn(channel: Channel): bigint {
    const channelRoles: RankedOverride[] = [];
    for (const role of this.roles) {
      const override = channel.rolePermissions[role.id];
      if (override) channelRoles.push({ rank: role.rank, permissions: override });
    }
    return channelPermissions({ ...this.#permissionInput(), channelDefault: channel.defaultPermissions, channelRoles });
  }

  /**
   * Whether this member ranks above `target`, the way Stoat checks kicks, bans and timeouts.
   * Stoat's server has the final word; this lets a bot refuse early with a clear message.
   */
  canModerate(target: Member): boolean {
    if (target.serverId !== this.serverId || target.id === this.id || target.isOwner) return false;
    if (this.isOwner) return true;
    return this.rank < target.rank;
  }

  /** Times the member out for `durationMs` from now. Returns the updated member. */
  async timeout(durationMs: number, reason?: string): Promise<Member> {
    const until = new Date(Date.now() + durationMs).toISOString();
    return this.#edit({ timeout: until }, reason);
  }

  async untimeout(reason?: string): Promise<Member> {
    return this.#edit({ remove: ["Timeout"] }, reason);
  }

  async kick(reason?: string): Promise<void> {
    await this.#client.rest.request("DELETE", `/servers/${this.serverId}/members/${this.id}`, undefined, { reason });
  }

  async ban(options: BanOptions = {}): Promise<void> {
    await banUser(this.#client, this.serverId, this.id, options);
  }

  async #edit(body: object, reason: string | undefined): Promise<Member> {
    const path = `/servers/${this.serverId}/members/${this.id}`;
    return new Member(this.#client, await this.#client.rest.request<RawMember>("PATCH", path, body, { reason }));
  }

  /** A copy with a ServerMemberUpdate's changes applied. */
  withUpdate(data: PartialMember, clear: string[] = []): Member {
    const next: Record<string, unknown> = { ...this.#raw, ...data, _id: this.#raw._id };
    for (const field of clear) if (CLEARABLE[field]) delete next[CLEARABLE[field]];
    return new Member(this.#client, next as RawMember);
  }

  #permissionInput(): ServerPermissionInput {
    return {
      owner: this.isOwner,
      serverDefault: this.server?.defaultPermissions ?? 0,
      roles: this.roles.map((role) => ({ rank: role.rank, permissions: role.permissions })),
      timedOut: this.isTimedOut(),
    };
  }
}

/** Shared by Member.ban and Server.ban. */
export async function banUser(client: Client, serverId: string, userId: string, options: BanOptions): Promise<void> {
  // No header: Stoat prefers the header over the body, and the header can't carry "—" or emoji.
  await client.rest.request("PUT", `/servers/${serverId}/bans/${userId}`, {
    reason: options.reason?.slice(0, 1024), // Stoat refuses longer ban reasons, and the ban with them
    delete_message_seconds: options.deleteMessageSeconds,
  });
}
