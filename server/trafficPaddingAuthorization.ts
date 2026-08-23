import type { User } from "../drizzle/schema";
import type { TrafficPaddingFields } from "../shared/trafficPadding";
import { ENV } from "./env";

/**
 * Reserved authorization boundary for the optional traffic-padding feature.
 * Keep this server-side check even while the first release is admin-only so a
 * future per-customer capability can be added without trusting the client.
 */
export function canEnableTrafficPadding(user: Pick<User, "role"> | null | undefined) {
  return user?.role === "admin";
}

/** Return true when an update newly enables or materially changes padding. */
export function trafficPaddingConfigurationRequiresAuthorization(
  previous: TrafficPaddingFields | null | undefined,
  next: TrafficPaddingFields,
) {
  // Turning the feature off is always allowed; the capability protects only
  // adding or changing cover traffic.
  if (!next.trafficPaddingEnabled) return false;
  if (!previous?.trafficPaddingEnabled) return true;
  return previous.trafficPaddingRatio !== next.trafficPaddingRatio
    || previous.trafficPaddingMaxMbps !== next.trafficPaddingMaxMbps;
}

export function assertTrafficPaddingEnableAuthorized(user: Pick<User, "role"> | null | undefined) {
  if (!ENV.trafficPaddingEnabled) {
    throw new Error("Traffic padding is disabled; set FORWARDX_TRAFFIC_PADDING_ENABLED=true and restart the panel");
  }
  if (!canEnableTrafficPadding(user)) {
    throw new Error("Traffic padding is currently restricted to administrators");
  }
}
