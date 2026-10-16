# ny / Nyanpass import (Experimental)

Open **Forwarding Rules → Batch Management → Batch Import**. Upload ny's JSON-lines export (`.json`, `.jsonl`, `.ndjson` or `.txt`), or select **ny (Experimental)** and paste it. A single JSON object or JSON-object array is also accepted. Legacy `name#port#host#port` text and full database backups are not supported.

1. Create/select a target ForwardX port resource, tunnel, forwarding chain or forwarding group. Servers, entry/exit groups, accounts, credentials and traffic history are not imported.
2. Choose TCP, UDP or TCP+UDP explicitly. The export lacks full protocol, paused-state and topology information, so the original deployment cannot be reconstructed automatically.
3. Review all destinations, entry ports, PROXY settings, balancing policies and rate limits; acknowledge the experimental limitations before importing.
4. **All ny rules are imported disabled.** Check them before enabling. Existing rules are never overwritten. Conflicting/out-of-range fixed ports remain failed items instead of being silently reassigned. Only `listen_port: 0` requests allocation under the target resource's port policy. After partial failure, retries contain only failed rules, not successful ones.

## Compatibility

| ny setting | Initial support |
| --- | --- |
| `name`, `listen_port`, a single `dest` | IPs, domains and `[IPv6]:port`; existing permissions/port validation still apply |
| Multiple `dest` entries | Up to 11, only for TCP GOST direct port-forwarding resources |
| `dest_policy` | `random`, `round`, `ip_hash`, `failover` map to ForwardX strategies; health checks and switching timing follow ForwardX, not necessarily ny |
| TCP PROXY | `accept_proxy_protocol: 1`, `proxy_protocol: 1/3`, only for TCP GOST/Realm direct port resources. The resource must already have matching PROXY settings; shared resources are not modified automatically |
| `speed_limit` | Administrators can import limits exactly convertible to whole Mbps (125000 bytes/s = 1 Mbps). Existing Agent-version requirements and administrator-managed rule restrictions still apply |
| UDP PROXY, `least_load`, TLS/SNI sub-rules | Rejected with an explicit reason |
| Non-zero `ip_limit` / `connection_limit`, unknown fields | Rejected rather than silently discarded |

Basic single-target rules can use other resource types. Mismatched PROXY settings block import to avoid unexpectedly adding or removing headers. This is configuration conversion, not ny node interoperability or a guarantee of seamless migration. Test a small batch before migrating the rest.

[中文说明](./rules.md#ny-nyanpass-导入-实验性)
