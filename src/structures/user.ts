import type { components } from "../generated/api.ts";
import { ulidToDate } from "../util/ulid.ts";

type RawUser = components["schemas"]["User"];

export class User {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly bot: boolean;

  constructor(raw: RawUser) {
    this.id = raw._id;
    this.username = raw.username;
    this.displayName = raw.display_name ?? raw.username;
    this.bot = raw.bot != null;
  }

  get createdAt(): Date {
    return ulidToDate(this.id);
  }
}
