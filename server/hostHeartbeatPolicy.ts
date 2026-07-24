// Keep online-state calculations consistent across host, token, tunnel and
// dashboard queries. The UI TTL is intentionally more tolerant than the
// dedicated failover liveness deadlines.
export { HOST_ONLINE_TTL_MS } from "../shared/hostHeartbeat";
