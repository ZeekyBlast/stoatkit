import { test } from "node:test";
import assert from "node:assert/strict";
import { routeKey } from "../src/rest/routeKey.ts";

test("groups routes the way Stoat counts them", () => {
  assert.equal(routeKey("/servers/S1"), "servers/S1");
  assert.equal(routeKey("/servers/S1/bans/U1"), "servers/S1");
  assert.equal(routeKey("/servers/S1/members/U1"), "servers/S1");
  assert.equal(routeKey("/servers/S1/audit_logs?limit=5"), "servers/S1");
  assert.equal(routeKey("/channels/C1/messages"), "channels/C1/messages");
  assert.equal(routeKey("/channels/C1/messages/M1"), "channels/C1/messages");
  assert.equal(routeKey("/channels/C1/messages/bulk"), "channels/C1/messages");
  assert.equal(routeKey("/channels/C1"), "channels/C1");
  assert.equal(routeKey("/users/@me"), "users");
  assert.equal(routeKey("/users/U1/dm"), "users");
  assert.equal(routeKey("/"), "root");
});
