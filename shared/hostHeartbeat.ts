// Agents send idle heartbeats every 60 seconds. Keep two full heartbeat
// intervals plus a small network/scheduler margin before declaring offline.
export const HOST_ONLINE_TTL_MS = 150 * 1000;
