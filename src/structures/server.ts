import type { Client } from "../client.ts";
import type { components } from "../generated/api.ts";
import type { Channel } from "./channel.ts";
import { banUser, type BanOptions, type Member } from "./member.ts";
import { Role } from "./role.ts";

export type RawServer = components["schemas"]["Server"];
type PartialServer = components["schemas"]["PartialServer"];

export class Server {
  readonly #client: Client;
  readonly #raw: RawServer;
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  /** The permission number every member starts from. */
  readonly defaultPermissions: number;
  /** Role events replace entries here. The same Map is shared by every snapshot of this server. */
  readonly roles: Map<string, Role>;

  constructor(client: Client, raw: RawServer, roles?: Map<string, Role>) {
    this.#client = client;
    this.#raw = raw;
    this.id = raw._id;
    this.name = raw.name;
    this.ownerId = raw.owner;
    this.defaultPermissions = raw.default_permissions;
    this.roles = roles ?? new Map(Object.entries(raw.roles ?? {}).map(([id, role]) => [id, new Role(raw._id, id, role)]));
  }

  get channels(): Channel[] {
    // ponytail: scans every cached channel; keep a per-server index if bots in huge servers need it
    return [...this.#client.channels.values()].filter((channel) => channel.serverId === this.id);
  }

  /** The bot's own member in this server. Always cached: Ready lists the bot's memberships. */
  get me(): Member | undefined {
    const botId = this.#client.user?.id;
    return botId ? this.#client.members.get(this.id, botId) : undefined;
  }

  /** Bans by user id, so it works for users who already left. */
  async ban(userId: string, options: BanOptions = {}): Promise<void> {
    await banUser(this.#client, this.id, userId, options);
  }

  async unban(userId: string, reason?: string): Promise<void> {
    await this.#client.rest.request("DELETE", `/servers/${this.id}/bans/${userId}`, undefined, { reason });
  }

  /** A copy with a ServerUpdate's changes applied. Roles carry over. */
  withUpdate(data: PartialServer): Server {
    return new Server(this.#client, { ...this.#raw, ...data } as RawServer, this.roles);
  }
}
