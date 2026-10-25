# Traffic accounting in restricted containers

Some LXC containers lack `CAP_NET_ADMIN`. Host NIC counters remain readable, but this does not provide per-rule counters. Installing firewall tools or enabling conntrack accounting cannot restore capabilities withheld by the host.

| Runtime | Without kernel-counter permissions |
| --- | --- |
| ForwardX native forwarding / tunnels | Existing in-process reporting |
| GOST forwarding / tunnel entry rules | Automatic native TCP/UDP fallback through the private local Unix socket API |
| Rules already using a protocol/rate-limit Guard | Native TCP/UDP counters in the existing Guard; no extra proxy |
| Unguarded Realm, socat, Nginx | Kernel counters still required; missing statistics are skipped and logged |
| iptables / nftables forwarding | Forwarding itself requires kernel permissions |

Working kernel counters remain preferred. Each rule uses one accounting source at a time. Native counters measure listener/forwarded bytes, excluding kernel packet headers and retransmissions; they are not identical to NIC/firewall totals. Relay and exit listeners are not counted again as entry-rule traffic. Host traffic is never substituted for rule traffic.

Update both the panel and Agent, then synchronize GOST rules to enable entry-listener statistics (`enableStats`, verified with GOST 3.2.6). The API is private and does not open a public port. Enabling statistics on existing listeners requires applying configuration; schedule this during maintenance. Collection itself is read-only and does not restart forwarding. Old runtimes or missing APIs produce a `traffic native GOST unavailable` log.

Initial samples, source switches and native listener replacements establish a conservative baseline rather than replaying old counters. One sampling window can be lost around such transitions; historical missing traffic cannot be reconstructed. Failed reports retain their frozen batch and baseline for retries. Check `traffic compatibility nativeRules=... unavailable=...` for fallback/unavailable rule counts.

Nginx session logs only account for completed sessions, so they are not used as a real-time billing/quota substitute. These fallbacks do not automatically enable source-IP analytics, IP limits or kernel-based rate limiting in unprivileged containers.

## Host TCP/UDP socket telemetry

Agents attach current IPv4 + IPv6 socket counts to regular and busy keepalive heartbeats. Counts apply to the Agent's network namespace (the container, not its hypervisor), not lifetime connections or individual forwarding rules.

- TCP reports in-use sockets (including listeners), TIME_WAIT, and their sum; this is not an ESTABLISHED-only count.
- UDP reports sockets, not remote clients or TCP-style connections.
- Linux reads small kernel summaries without `CAP_NET_ADMIN` or full connection-table scans. Samples are cached for 5 seconds; report cadence follows heartbeats. Unavailable counts carry a reason and omit numbers instead of reporting a false zero.

The host list shows TCP and UDP connections by default; both columns can be hidden, reordered and resized in list settings. Hover to see count definitions, TCP details and sample time. Offline, missing or expired samples display `—`, not a false zero. The backend retains only the latest snapshot in memory for 15 minutes, also exposed in administrator support exports as `panelHosts[].connectionStats`. No database migration or history storage is needed. Update the Agent to enable reporting; older Agents remain compatible.

[中文说明](./traffic-latency.md#受限-lxc-容器的统计兼容)
