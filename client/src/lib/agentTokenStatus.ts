export type AgentTokenHostStatus = {
  isOnline?: boolean | null;
  lastHeartbeat?: unknown;
};

// The token API already applies the server heartbeat policy. Rechecking the
// database timestamp in the browser can disagree with the host management page.
export function isTokenHostOnline(host: AgentTokenHostStatus | null | undefined) {
  return host?.isOnline === true;
}
