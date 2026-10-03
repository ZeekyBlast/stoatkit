import type { components } from "../generated/api.ts";

export type RawRole = components["schemas"]["Role"];
type PartialRole = components["schemas"]["PartialRole"];
type OverrideField = components["schemas"]["OverrideField"];

export class Role {
  readonly #raw: RawRole;
  readonly id: string;
  readonly serverId: string;
  readonly name: string;
  /** Position in the role list. A lower rank is a higher role; 0 is the top. */
  readonly rank: number;
  readonly permissions: OverrideField;
  readonly colour: string | null;
  readonly hoist: boolean;

  // The id comes from the map key or the event, not the body: role bodies in events may leave it out.
  constructor(serverId: string, id: string, raw: RawRole) {
    this.#raw = raw;
    this.id = id;
    this.serverId = serverId;
    this.name = raw.name ?? "";
    this.rank = raw.rank ?? 0;
    this.permissions = raw.permissions ?? { a: 0, d: 0 };
    this.colour = raw.colour ?? null;
    this.hoist = raw.hoist ?? false;
  }

  /** A copy with a ServerRoleUpdate's changes applied. */
  withUpdate(data: PartialRole, clear: string[] = []): Role {
    const next = { ...this.#raw, ...data } as RawRole;
    if (clear.includes("Colour")) delete next.colour;
    return new Role(this.serverId, this.id, next);
  }
}
