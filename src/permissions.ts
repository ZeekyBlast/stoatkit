import type { components } from "./generated/api.ts";

type OverrideField = components["schemas"]["OverrideField"];

/**
 * Stoat's permission bits. Some sit above bit 31 (ViewAuditLogs is bit 40), and JavaScript's `|` and `&`
 * on plain numbers cut values to 32 bits. So every permission value here is a bigint.
 */
export const Permission = {
  ManageChannel: 1n << 0n,
  ManageServer: 1n << 1n,
  ManagePermissions: 1n << 2n,
  ManageRole: 1n << 3n,
  ManageCustomisation: 1n << 4n,
  KickMembers: 1n << 6n,
  BanMembers: 1n << 7n,
  TimeoutMembers: 1n << 8n,
  AssignRoles: 1n << 9n,
  ChangeNickname: 1n << 10n,
  ManageNicknames: 1n << 11n,
  ChangeAvatar: 1n << 12n,
  RemoveAvatars: 1n << 13n,
  ViewChannel: 1n << 20n,
  ReadMessageHistory: 1n << 21n,
  SendMessage: 1n << 22n,
  ManageMessages: 1n << 23n,
  ManageWebhooks: 1n << 24n,
  InviteOthers: 1n << 25n,
  SendEmbeds: 1n << 26n,
  UploadFiles: 1n << 27n,
  Masquerade: 1n << 28n,
  React: 1n << 29n,
  Connect: 1n << 30n,
  Speak: 1n << 31n,
  Video: 1n << 32n,
  MuteMembers: 1n << 33n,
  DeafenMembers: 1n << 34n,
  MoveMembers: 1n << 35n,
  Listen: 1n << 36n,
  MentionEveryone: 1n << 37n,
  MentionRoles: 1n << 38n,
  BypassSlowmode: 1n << 39n,
  ViewAuditLogs: 1n << 40n,
} as const;

export type PermissionName = keyof typeof Permission;

/** What the server owner gets: every bit Stoat may ever use (its `GrantAllSafe`). */
export const ALL_PERMISSIONS = (1n << 52n) - 1n;

/** A timed-out member keeps only these. */
const ALLOW_IN_TIMEOUT = Permission.ViewChannel | Permission.ReadMessageHistory;

/** An allow/deny pair plus the rank of the role it belongs to. A lower rank is a higher role. */
export interface RankedOverride {
  rank: number;
  permissions: OverrideField;
}

export interface ServerPermissionInput {
  owner: boolean;
  /** The server's `default_permissions`. */
  serverDefault: number;
  /** The member's roles. */
  roles: RankedOverride[];
  timedOut: boolean;
}

export interface ChannelPermissionInput extends ServerPermissionInput {
  /** The channel's `default_permissions`, if it has one. */
  channelDefault: OverrideField | null;
  /** The channel's overrides for the member's roles, each with that role's rank. */
  channelRoles: RankedOverride[];
}

/** Stoat's rule: allow first, then deny. */
function apply(value: bigint, override: OverrideField): bigint {
  return (value | BigInt(override.a)) & ~BigInt(override.d);
}

/** Lowest role first, so the highest role (lowest rank number) is applied last and wins. */
function applyRanked(value: bigint, overrides: RankedOverride[]): bigint {
  for (const { permissions } of [...overrides].sort((x, y) => y.rank - x.rank)) value = apply(value, permissions);
  return value;
}

// ponytail: voice-only rules (can_publish / can_receive revoking Speak, Video, Listen) skipped; voice is a non-goal
export function serverPermissions(input: ServerPermissionInput): bigint {
  if (input.owner) return ALL_PERMISSIONS;
  let value = applyRanked(BigInt(input.serverDefault), input.roles);
  if (input.timedOut) value &= ALLOW_IN_TIMEOUT;
  return value;
}

export function channelPermissions(input: ChannelPermissionInput): bigint {
  if (input.owner) return ALL_PERMISSIONS;
  let value = BigInt(input.serverDefault);
  if (input.channelDefault) value = apply(value, input.channelDefault);
  value = applyRanked(value, input.roles);
  value = applyRanked(value, input.channelRoles);
  if (input.timedOut) value &= ALLOW_IN_TIMEOUT;
  return value & Permission.ViewChannel ? value : 0n;
}

/** The names in `wanted` that `value` lacks. Empty means it has them all. */
export function missingPermissions(value: bigint, wanted: readonly PermissionName[]): PermissionName[] {
  return wanted.filter((name) => (value & Permission[name]) !== Permission[name]);
}
