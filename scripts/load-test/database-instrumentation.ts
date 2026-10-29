/** Instrument physical connections, never replace methods on a guarded pool.
 * A pool proxy may resolve connect/query through its own admission controller;
 * assigning a wrapper there can route the raw driver back into that controller.
 */
export function instrumentPoolConnections(pool: any, kind: "mysql" | "postgresql", wrapClient: (client: any) => unknown) {
  if (kind === "mysql") {
    const raw = pool.pool;
    for (const client of raw._allConnections.toArray()) wrapClient(client);
    raw.on("connection", wrapClient);
    return () => raw.removeListener("connection", wrapClient);
  }
  for (const client of pool._clients) wrapClient(client);
  pool.on("connect", wrapClient);
  return () => pool.removeListener("connect", wrapClient);
}
