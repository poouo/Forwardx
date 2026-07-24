const FORWARDX_MIMIC_KEEPALIVE = "300:10:3:600";

/**
 * V1 FXP and V2 userspace WireGuard both expose Mimic as a userspace UDP
 * transport. Keep their per-interface configuration identical so a host does
 * not change packet handling when a tunnel version is switched.
 */
export function buildForwardXMimicConfig(filters: Iterable<string>) {
  const uniqueFilters = Array.from(new Set(
    Array.from(filters || [])
      .map((filter) => String(filter || "").trim())
      .filter(Boolean),
  )).sort();
  return [
    "# Managed by ForwardX",
    "log.verbosity = info",
    // Mimic 0.7.1 detects Ethernet, loopback, PPP and TUN link types.
    "use_libxdp = false",
    `keepalive = ${FORWARDX_MIMIC_KEEPALIVE}`,
    "max_window = false",
    ...uniqueFilters.map((filter) => `filter = ${filter}`),
  ].join("\n");
}
