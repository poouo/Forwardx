import { ENV } from "./env";
import {
  normalizeTrafficPadding,
  type TrafficPaddingFields,
  type TrafficPaddingRuntime,
} from "../shared/trafficPadding";

export type GlobalTrafficPaddingConfig = {
  enabled: boolean;
};

export const globalTrafficPaddingConfig: GlobalTrafficPaddingConfig = {
  enabled: ENV.trafficPaddingEnabled === true,
};

/**
 * Resolve the values sent to an Agent. The environment switch is the
 * developer-controlled capability gate; the ratio and optional cap remain
 * explicit per-tunnel settings so enabling the feature cannot silently add
 * traffic to every existing tunnel.
 */
export function effectiveTrafficPadding(
  tunnel: Partial<TrafficPaddingFields> | null | undefined,
  runtime: TrafficPaddingRuntime = {},
  config: GlobalTrafficPaddingConfig = globalTrafficPaddingConfig,
) {
  const source = config.enabled ? tunnel : undefined;
  return normalizeTrafficPadding(source, runtime);
}
