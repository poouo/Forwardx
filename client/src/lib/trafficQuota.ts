export type TrafficQuotaSourceKind = "manual" | "plan" | "addon" | "grant";

export type TrafficQuotaSource = {
  kind: TrafficQuotaSourceKind;
  bytes: number;
  unlimited: boolean;
};

export type TrafficQuotaBreakdown = {
  sources: TrafficQuotaSource[];
  totalBytes: number;
  unlimited: boolean;
  hasQuota: boolean;
};

function positiveBytes(value: unknown) {
  const bytes = Math.floor(Number(value) || 0);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

function isActiveSubscription(subscription: any, now: number) {
  if (subscription?.status !== "active") return false;
  if (!subscription?.expiresAt) return true;
  const expiresAt = new Date(subscription.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function trafficQuotaBreakdown(
  user: any,
  subscriptions: any[] = [],
  now = Date.now(),
): TrafficQuotaBreakdown {
  const activeSubscriptions = subscriptions.filter((subscription) => isActiveSubscription(subscription, now));
  const hasPlan = activeSubscriptions.length > 0;
  const planUnlimited = hasPlan
    && activeSubscriptions.some((subscription) => positiveBytes(subscription?.trafficLimit) === 0);
  const planBytes = hasPlan && !planUnlimited
    ? activeSubscriptions.reduce((total, subscription) => total + positiveBytes(subscription?.trafficLimit), 0)
    : 0;
  const reportedAddonBytes = activeSubscriptions.reduce(
    (total, subscription) => total + positiveBytes(subscription?.activeTrafficAddonBytes),
    0,
  );
  const purchasedAddonBytes = activeSubscriptions.reduce(
    (total, subscription) => total + positiveBytes(subscription?.purchasedTrafficAddonBytes),
    0,
  );
  const grantedAddonBytes = activeSubscriptions.reduce(
    (total, subscription) => total + positiveBytes(subscription?.grantedTrafficAddonBytes),
    0,
  );
  const splitAddonBytes = purchasedAddonBytes + grantedAddonBytes;
  const addonBytes = Math.max(reportedAddonBytes, splitAddonBytes);
  const unclassifiedAddonBytes = Math.max(0, addonBytes - splitAddonBytes);

  const manualBytes = positiveBytes(user?.manualTrafficLimit);
  const manualUnlimited = manualBytes === 0 && !hasPlan && user?.manualCanAddRules === true;
  const hasManual = manualBytes > 0 || manualUnlimited;

  const sources: TrafficQuotaSource[] = [];
  if (hasManual) sources.push({ kind: "manual", bytes: manualBytes, unlimited: manualUnlimited });
  if (hasPlan) sources.push({ kind: "plan", bytes: planBytes, unlimited: planUnlimited });
  if (purchasedAddonBytes + unclassifiedAddonBytes > 0) {
    sources.push({ kind: "addon", bytes: purchasedAddonBytes + unclassifiedAddonBytes, unlimited: false });
  }
  if (grantedAddonBytes > 0) sources.push({ kind: "grant", bytes: grantedAddonBytes, unlimited: false });

  const unlimited = manualUnlimited || planUnlimited;
  const baseBytes = Math.max(manualBytes, planBytes);
  const totalBytes = unlimited ? 0 : baseBytes + addonBytes;

  return {
    sources,
    totalBytes,
    unlimited,
    hasQuota: sources.length > 0,
  };
}
