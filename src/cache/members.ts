import type { Member } from "../structures/member.ts";

/** Members by server, then by user id. */
export class MemberCache {
  readonly #servers = new Map<string, Map<string, Member>>();

  get(serverId: string, userId: string): Member | undefined {
    return this.#servers.get(serverId)?.get(userId);
  }

  set(member: Member): void {
    let server = this.#servers.get(member.serverId);
    if (!server) this.#servers.set(member.serverId, (server = new Map()));
    server.set(member.id, member);
  }

  delete(serverId: string, userId: string): Member | undefined {
    const member = this.get(serverId, userId);
    this.#servers.get(serverId)?.delete(userId);
    return member;
  }

  deleteServer(serverId: string): void {
    this.#servers.delete(serverId);
  }
}
