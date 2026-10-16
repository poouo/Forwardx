# Operations dashboard

[简体中文](./operations.md)

Administrators can open **Management → Operations** to view today or a date range within the last 30 days. Calendar days use **Beijing time (UTC+8)**.

## Traffic and history

View incoming/outgoing rule traffic, daily trends, and rankings by user, host, logical rule and resource. Multi-entry members are combined under their logical rule. Existing accounting-host selection prevents relay hops from being counted twice.

The dashboard defaults to **Admin**, meaning the current administrator's account. Choose all users or a specific user to filter trends, rankings, the source map and IP details together. Host health and group events are limited to resources associated with that user's rules.

Totals are actual rule traffic, without billing multipliers; they are not host NIC totals. Observed host downtime and forwarding-group events are also shown. The online-host count is current, not historical.

Daily summaries stay in the configured database for up to 30 calendar days. Collection starts after upgrading; earlier history is not backfilled. Stored summaries remain until expiry even if a rule is deleted.

Full backups include source IP history and should be protected accordingly. Essential/configuration-only migration omits these operational histories.

## Billing overview

Billing follows the same date and user filters, defaults to **Admin** (the current administrator's account), and is admin-only.

- Online receipts include successful production top-up and plan payments, grouped by currency without conversion. Test, pending, cancelled and failed orders are excluded.
- Receipts use the payment date, falling back to creation time for legacy orders without a payment timestamp. New-order statuses use creation time, so their counts may differ.
- Wallet spending separates plan purchases, traffic add-ons and metered traffic. A payment and its wallet credit are not two revenues; traffic billing uses wallet deductions without recounting billing detail records.
- Manual top-ups, redeemed credits and adjustments are separate from online receipts. Wallet records use the existing CNY ledger.
- New subscriptions use creation time, not purchase or renewal counts. Active subscriptions reflect current status rather than a historical snapshot.
- Payments and wallet entries are listed separately, newest first, 10 per page. Do not sum the raw ledger entries. Open the full billing ledger for management.

Reports query existing financial records with time/user indexes and a short cache. They do not create a second accounting ledger, and 30-day operational-history cleanup never deletes financial records.

## Source IPs and the China map

Source collection is **off by default** and admin-only. Enable **Collect source IPs** after reviewing the privacy notice, and upgrade Agents. Policy changes can take one or two traffic-report cycles. Disabling collection does not interrupt forwarding or immediately erase retained history.

Province colors run from blue through cyan, green and amber to red as source IP counts increase. Hover for incoming/outgoing traffic and the top five IPs; click to pin rule/host counts and available city/ISP details. Corner summaries show overseas and unlocated sources. The IP list shows 10 rows per page, ordered by most traffic by default; most rules and most recent are also available. Click an IP for its related rules, hosts, rule owners and sampled bytes. The map and totals cover all matching records, not just the current page.

These are observations, not complete visitor analytics:

- Periodic ingress conntrack snapshots may miss short-lived connections. An observed connection does not prove successful authentication or protocol negotiation.
- Sampled bytes are observed counter deltas, not full-session or billable traffic. The first sample, Agent restarts and counter resets establish a new baseline instead of importing old bytes.
- NAT, CDN and upstream proxies may hide the original client. Untrusted PROXY headers are not used to infer client identity.
- Local forwarding ingress rules with conntrack visibility are supported; exit/relay nodes are excluded. Native ForwardX tunnel endpoints do not yet report independent source observations.
- Requires readable `/proc/net/nf_conntrack` / `/proc/net/ip_conntrack`, or an installed and permitted `conntrack` CLI. Collection does not install tools or change kernel/firewall settings.
- Missing kernel byte counters display **Unavailable**, not zero. Partially missing samples carry `*`.
- Limits: 5000 IP/rule pairs per host/day, 1000 rows per report, and 20000 tracked flows. Limits, unavailable dependencies and stale status are visible.
- Deltas are assigned to the sampling date, without splitting intervals across midnight. Retries retain the original sample date and use the existing traffic-report deduplication.

## Geolocation and privacy

Source analytics uses the bundled **ip2region IPv4/IPv6 offline database** for Chinese provinces and overseas countries, without consuming API quota or transmitting source IPs. Private/reserved and unknown addresses are not guessed. Existing valid location cache entries may be reused. Routine host geolocation continues using its existing API workflow.

Dashboard queries process up to 256 pending IPs; **Locate offline** processes up to 512 more per request. Results use a separate database cache for up to 30 days. Each IP-family database is loaded lazily once: approximately 12 MiB compressed assets, or 46 MiB of data memory when both families are loaded.

Map geometry and IP databases ship with the source, local runtime bundle and Docker image, with no runtime download. Missing or corrupt databases log a warning and leave locations unknown, without falling back to an external API. Database updates ship with panel updates. Locations describe network allocations, not precise user locations; ensure collection complies with your privacy policy.

## Troubleshooting collection

On an ingress host, check the following. Output may contain client IPs; redact it before sharing publicly.

```bash
command -v conntrack
conntrack -L -o extended | head -n 5
sysctl net.netfilter.nf_conntrack_acct
```

On Debian/Ubuntu, an administrator can install a missing CLI with `apt-get install conntrack`. If records have no `bytes=` fields and source traffic is needed, an administrator may evaluate enabling accounting with `sysctl -w net.netfilter.nf_conntrack_acct=1`. New connections are usually required; persistent configuration is managed separately by the administrator. The panel never changes this option automatically.
