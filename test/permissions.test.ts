import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_PERMISSIONS,
  Permission,
  channelPermissions,
  missingPermissions,
  serverPermissions,
  type ChannelPermissionInput,
  type PermissionName,
} from "../src/permissions.ts";

/** Builds a permission number from names, the way Stoat sends them in JSON. */
const bits = (...names: PermissionName[]) => Number(names.reduce((v, n) => v | Permission[n], 0n));
const allow = (...names: PermissionName[]) => ({ a: bits(...names), d: 0 });
const deny = (...names: PermissionName[]) => ({ a: 0, d: bits(...names) });

const member = { owner: false, serverDefault: bits("ViewChannel", "SendMessage"), roles: [], timedOut: false };
const inChannel: ChannelPermissionInput = { ...member, channelDefault: null, channelRoles: [] };

test("with no roles a member has the server default", () => {
  assert.equal(serverPermissions(member), Permission.ViewChannel | Permission.SendMessage);
});

test("the owner has everything, whatever the roles say", () => {
  const value = serverPermissions({ ...member, owner: true, roles: [{ rank: 0, permissions: deny("SendMessage") }] });
  assert.equal(value, ALL_PERMISSIONS);
});

test("a role adds its allows", () => {
  const value = serverPermissions({ ...member, roles: [{ rank: 3, permissions: allow("KickMembers") }] });
  assert.deepEqual(missingPermissions(value, ["KickMembers", "SendMessage"]), []);
});

test("the higher role (lower rank number) wins a conflict", () => {
  const modsDeny = serverPermissions({
    ...member,
    roles: [
      { rank: 5, permissions: allow("ManageMessages") },
      { rank: 1, permissions: deny("ManageMessages") },
    ],
  });
  assert.deepEqual(missingPermissions(modsDeny, ["ManageMessages"]), ["ManageMessages"]);

  const modsAllow = serverPermissions({
    ...member,
    roles: [
      { rank: 0, permissions: allow("ManageMessages") },
      { rank: 3, permissions: deny("ManageMessages") },
    ],
  });
  assert.deepEqual(missingPermissions(modsAllow, ["ManageMessages"]), []);
});

test("bits above 31 are kept (ViewAuditLogs is bit 40)", () => {
  // The real default from the recorded Ready frame: it does not fit in 32 bits.
  assert.equal(serverPermissions({ ...member, serverDefault: 77014766592 }), 77014766592n);
  const value = serverPermissions({ ...member, roles: [{ rank: 0, permissions: allow("ViewAuditLogs", "Video") }] });
  assert.deepEqual(missingPermissions(value, ["ViewAuditLogs", "Video", "ViewChannel"]), []);
  const denied = serverPermissions({
    ...member,
    serverDefault: bits("ViewChannel", "ViewAuditLogs"),
    roles: [{ rank: 0, permissions: deny("ViewAuditLogs") }],
  });
  assert.equal(denied, Permission.ViewChannel);
});

test("a timed-out member can only view and read history", () => {
  const value = serverPermissions({ ...member, timedOut: true, roles: [{ rank: 0, permissions: allow("BanMembers") }] });
  assert.equal(value, Permission.ViewChannel);
});

test("a channel's default deny takes a permission away", () => {
  assert.deepEqual(missingPermissions(channelPermissions({ ...inChannel, channelDefault: deny("SendMessage") }), ["SendMessage"]), [
    "SendMessage",
  ]);
});

test("a server role's allow beats the channel's default deny", () => {
  const value = channelPermissions({
    ...inChannel,
    channelDefault: deny("SendMessage"),
    roles: [{ rank: 2, permissions: allow("SendMessage") }],
  });
  assert.deepEqual(missingPermissions(value, ["SendMessage"]), []);
});

test("a channel role override beats the server role", () => {
  const value = channelPermissions({
    ...inChannel,
    roles: [{ rank: 2, permissions: allow("ManageMessages") }],
    channelRoles: [{ rank: 2, permissions: deny("ManageMessages") }],
  });
  assert.deepEqual(missingPermissions(value, ["ManageMessages"]), ["ManageMessages"]);
});

test("without ViewChannel a member has nothing in that channel", () => {
  const value = channelPermissions({
    ...inChannel,
    roles: [{ rank: 0, permissions: allow("KickMembers") }],
    channelDefault: deny("ViewChannel"),
  });
  assert.equal(value, 0n);
});

test("the owner has everything in every channel", () => {
  assert.equal(channelPermissions({ ...inChannel, owner: true, channelDefault: deny("ViewChannel") }), ALL_PERMISSIONS);
});
