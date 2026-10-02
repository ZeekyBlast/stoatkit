/**
 * Groups request paths the way Stoat rate-limits them: every `/servers/:id/...` call shares one
 * bucket per server, messages share one per channel, everything else one per top-level resource.
 */
export function routeKey(path: string): string {
  const [first, id, third] = path.split("?")[0]!.split("/").filter(Boolean);
  if (!first) return "root";
  if (first === "servers" && id) return `servers/${id}`;
  if (first === "channels" && id) return third === "messages" ? `channels/${id}/messages` : `channels/${id}`;
  return first;
}
