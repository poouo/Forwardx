# Changelog

[简体中文](CHANGELOG.md) | [English](CHANGELOG.en.md)

## [Unreleased]

## [2.3.282] - 2026-10-07

### Features and configuration

- Provide complete Chinese/English changelog histories and include both languages automatically in GitHub Releases, with checks for missing release sections or translations.
- Reorganize deployment and usage documentation into Docker, local installation, databases, HTTPS, paths/logs, account recovery, migration and development guides. Update both READMEs, move AI and per-rule quota documentation to their own sections, and correct outdated commands, container environment handling, installer configuration preservation and consistent SQLite backups.
- Add optional Google registration and sign-in, disabled by default. Administrators configure a Web OAuth client and callback in Settings; users can explicitly link accounts, confirm unlinking with a password, and set a password for a new Google-only account. Preserve registration controls, email allowlists, ordinary-user permissions, disabled-account checks, 2FA and session policies; never automatically merge accounts with matching emails. Protect flows with one-time browser-bound state, PKCE, signature/audience/nonce checks, request timeouts and rate limits. Keep secrets out of browser responses and plaintext audit logs, with Chinese/English UI and setup documentation.
- Support per-rule quotas for rules owned by administrators themselves, including rules shared with other people without separate user accounts. Add regression coverage for ordinary administrator-owned rules, generated group members, independent usage accounting and recovery; administrator privileges do not bypass these limits.
- Add dynamic AI parameter buttons: after specifying a target, choose an authorized tunnel, forwarding chain or forwarding group, with pagination, random/manual entry ports and TCP/UDP choices. Preserve the target and unfinished steps across restarts, invalidate stale buttons, recheck permissions, and require final confirmation. Known settings with a missing on/off value also offer buttons in Telegram and Discord.
- Show usage, quota, remaining allowance and counting mode for administrator-managed rules in user cards and lists. Persist managed ownership: users may view but cannot edit, enable/disable, delete, sort or reset these rules. Clearing limits does not remove the read-only restriction; ordinary self-created rules are unaffected. Apply the same permissions to bots and batch operations.
- Add a collapsed per-rule configuration section for administrators: speed limits, traffic quotas, outbound-only/combined/maximum-direction accounting, editable creation and expiry dates using the calendar, and optional time values. Quota/expiry suspensions cover generated group members and tunnel endpoints without changing the configured enabled switch. Removing the restriction restores service; ordinary users cannot modify limits or reset restricted usage. Establish a baseline from cumulative ingress counters, then persist logical-rule usage transactionally so resource switches, member rebuilds and creation-date edits do not clear it. Include Chinese/English UI and controlled AI queries/updates.
- Expand controlled AI tools to cover rule editing and resource-specific creation, upcoming account/host/subscription expiry, system/protocol/menu switches, host traffic and renewal configuration, tunnels/groups, user quotas and resource permissions, plans/subscriptions, usage billing and announcements. Reuse web validation and permissions; preview and confirm each write step. Keep unfinished parameters through restarts and expired confirmations, preserve unspecified fields, and reject stale previews after concurrent changes. Credentials, database migration, upgrades and arbitrary commands remain outside natural-language write tools.

### Fixes and improvements

- Rebuild bot AI operations around intent, minimal authorized context, structured plans, business validation and step-by-step confirmation. Persist parameters, missing inputs, remaining steps and progress; resume with “continue” after restart or confirmation expiry. Isolate channels, users and chats, prevent duplicate execution, and stop automatic retries when an outcome is uncertain. Fix renewal dates being overwritten by entitlement synchronization and bound model response-body time and size.
- Fix manual latency batches being claimed too early, losing partial results or failing to aggregate after panel restart. Persist complete tunnel/chain jobs before dispatch, keep original requests/results, make duplicate reports idempotent and prevent old batches overwriting new ones. Retries do not extend the original timeout; add overall deadlines and stale-state recovery.
- Correct manual probe topology and aggregation for multiple entries/exits and standby relays. Evaluate complete available paths instead of treating alternatives as serial hops; background probes no longer overwrite active manual tests. Keep completed segment results, show request/refresh/deadline failures, and clarify that a TCP connection is not an authenticated application handshake. Do not change normal forwarding state.
- Improve Chinese/English layouts: sliding tabs reserve translated text, icon and count widths, scroll locally when needed and track actual label sizes. Allow long labels and action bars to wrap in tabs, dialogs, hosts, rules, links and users. Shorten English navigation/action text and adapt notification forms, binding status and plugin dialogs without dropping explanations or changing business behavior.
- Let installers choose the initial setup language with --language zh-CN|en|auto for Docker/local deployments. Chinese and English README commands pass their respective language; upgrades preserve it. The wizard switches language without losing form inputs, manual browser choices take priority, and normal automatic detection resumes after initialization.
- Add Discord Bot notifications as an alternative to Telegram, which remains the default. Switching preserves each channel's configuration and bindings. Support private binding/unbinding, announcement subscriptions, usage/rules, one-time web login, administrator actions, AI queries/confirmations and host/traffic/expiry/group-switch/rule-error notifications. Adapt Slash Commands, buttons, message limits and rate limits; validate Bot identity before saving, bound interaction queues and reconnect Gateway sessions on timeout. Never reuse Telegram credentials; report private-message delivery failures explicitly.
- Fix forwarding self-tests clearing tunnel runtime status, causing unnecessary reapplication and delaying probes. Probe-only refresh preserves runtime state and configuration versions; configuration edits still use the reapply path. Pending probes retain fast-heartbeat retries during recovery without bypassing readiness checks or hiding failures with longer timeouts.
- Add Simplified Chinese/English UI selection in account menus, login and initial setup. Automatic mode prioritizes browser language, then existing IP-country hints or trusted-proxy country data, without new visitor-location requests. Persist manual browser preferences and localize dates/currency. Add an English README with cross-links; preserve user content and raw diagnostics.
- Fix newly added GOST forwarding-chain rules restarting shared host runtimes and interrupting other chains. The new Agent adds listeners/dependencies through a root-private Unix socket while keeping unchanged rules running. Port conflicts or apply failures roll back only the addition, without restarting the shared process. Initial API activation requires one service restart; edits, deletions and runtime failures retain existing recovery behavior. Older Agents remain compatible.
- Add an iOS/iPadOS 15+ project and independent macOS GitHub build workflow producing unsigned arm64 IPA, SHA256 and signing instructions. Support manual builds and tag-based Release uploads without Apple signing secrets, plus download links, iOS update checks, LAN permissions and safe-area handling. Users handle signing and installation.
- Add optional seamless panel migration through the old URL: freeze writes, export a consistent snapshot, preserve IDs/Tokens/ports/runtime state and suppress rebuild/cleanup actions during verification. Do not require Agent/runtime restarts; retain the old database read-only and persist resumable migration state. Both panels must use the same version and database type, the destination must have no business data, and the old URL/forwarding service must remain available. Seamless incremental merging is unsupported.
- Fix standalone host monitoring (default /dev) not requesting live metrics, stalled refresh after hanging requests and transient failures appearing as missing pages. Add isolated requests/timeouts, visibility/network recovery, last-refresh time and manual retry. Preserve previous data on errors, prioritize current metrics in details and avoid excessive chart parameters with long ranges/many services.
- Fix rule category/link filtering shrinking the “All” count and zeroing unrelated badges. Compute category counts independently of category/link selection within the current user/search scope; pagination and summaries still follow the selected link. Keep complete counts during loading rather than estimating from one page.
- Fix probe failure rates being inflated by throttled successful reports. Agents retain bounded cumulative counters; the panel uses monotonic snapshot deltas and ignores duplicate/out-of-order reports. Hop caches still inform health, but are not independent failure samples.
- Distinguish Ping packet loss, TCP connection failures and hop-probe failures with explicit coverage. Do not use legacy sampled rows for accurate failure rates or stability scores; retain their latency curves. Chart smoothing no longer changes stability statistics, and compressed multi-batch counters are no longer truncated.

### Versions and upgrade notes

- Panel and APK release: 2.3.282; Android app: 2.3.99; iOS app: 1.0.0; Agent: 2.2.195; ForwardX FXP runtime remains `2.2.117`.
- Back up databases and custom deployment configuration before upgrading. Google sign-in is disabled by default; Telegram remains the default bot channel. Seamless migration requires the old URL and forwarding service to stay running.
- Upgrade Agents to use incremental GOST additions. Initial API activation restarts the shared runtime once; subsequent additions can retain unchanged listeners. Edits, deletions and recovery may still rebuild runtimes.
- The IPA is unsigned and requires user-provided signing/installation. Platform packages and Docker images build in independent GitHub Actions and may become available after the code push.

## [2.3.281] - 2026-10-02

### Fixes and improvements

- Fix infinite Map iteration during captcha-refresh and 2FA rate-limit cleanup, preventing full panel CPU utilization and unresponsive Web/API service while retaining rate limits and capacity guards. Add live/mixed-expiry regression cases.
- Add host traffic failover switches and percentage thresholds. Temporarily exclude over-quota hosts from forwarding groups, failover and tunnel entry/exit groups using the host's accounting mode. Preserve members/ports and restore eligibility after a traffic reset or disabling the switch.
- Keep a Web diagnostic page available on database failures, with sanitized causes, error codes and troubleshooting advice; recover automatically without clearing login cookies.
- Fix PostgreSQL idle-connection errors and asynchronous Agent database reads exiting the panel process. Static pages/assets no longer depend on Agent database checks.
- Add bounded, non-overlapping database health checks, pause database-dependent scheduled jobs during outages, and cache verified panel TLS configuration for startup without the database.
- Make administrator rule creation, copies, imports and traffic resets follow the selected user; “All users” creation defaults to the administrator. Validate target-user permissions, quotas and port policies.
- Use the server's effective host/tunnel/group/plan port policy in rule editors, avoiding hints that allow port 65535 while saving rejects it.
- Treat iperf3 as an optional, independently installed dependency. Failed installation warns that network tests are unavailable without interrupting Agent installation.
- Fix toast text/background mismatch when switching between light and dark themes.

### Versions

- Panel/APK release: 2.3.281; Android: 2.3.98; Agent: 2.2.194; ForwardX FXP runtime: `2.2.117`.

## [2.3.280] - 2026-09-08

### Fixes and improvements

- Fix two-level link filtering and the main rule list disappearing when opening batch management.
- Improve latency statistics, tunnel port allocation, group member limits and Agent runtime recovery.
- Improve Agent/panel diagnostics and traffic reporting for long-running stability.

### Versions

- Panel/APK release: 2.3.280; Agent: 2.2.194; ForwardX FXP runtime: 2.2.117; Android: 2.3.97.

## [2.3.279] - 2026-09-03

### Fixes and improvements

- Improve heartbeat, traffic, recovery and diagnostic logs across the panel, Agent and FXP, reducing CPU/memory/event-loop pressure during failures.
- Add backpressure, timeouts, deduplication and bounds to SSE, support bundles, logs, caches and queues.
- Optimize SQLite metrics/history cleanup, Agent registration/upgrades and Realm-compatible asset fallback.
- Prevent old failover groups silently inheriting tool or PROXY settings during upgrades; preserve existing member runtime settings.

### Versions

- Panel/APK release: 2.3.279; Agent: 2.2.193; ForwardX FXP runtime: 2.2.117; Android: 2.3.97.

## [2.3.278] - 2026-08-30

### Fixes and improvements

- Fix FXP multi-exit failover, connection limits and tunnel recovery so one problematic entry does not affect an entire path.
- Fix forwarding-group tool/PROXY inheritance and stale nftables/iptables cleanup when switching tools.
- Improve asset/runtime installation and upgrade validation for Agent/FXP and Realm/GOST/Nginx, preserving working binaries when candidates fail.
- Stop generating obsolete transport options incompatible with Realm 2.9.x.
- Improve latency details, local development and Agent/FXP state synchronization.

### Versions

- Panel/APK release: 2.3.278; Agent: 2.2.192; ForwardX FXP runtime: 2.2.116; Android: 2.3.97.

## [2.3.277] - 2026-08-23

### Fixes and improvements

- Fix local development proxies, automatic sign-in and shutdown cleanup to reduce disconnect noise.
- Improve Agent/FXP state, traffic/connection counters and rule recovery.
- Fix whitelist-plugin nftables error handling; improve login challenges and installation/upgrade scripts.

### Versions

- Panel/APK release: 2.3.277; Agent: 2.2.191; ForwardX FXP runtime: 2.2.115; Android: 2.3.97.

## [2.3.276] - 2026-08-14

### Added

- Add interactive local/container administrator password-reset commands that revoke existing sessions.

### Fixes and improvements

- Harden disabled accounts, 2FA, Telegram login, payment callbacks, billing and concurrent port allocation.
- Optimize port policies, logs, state caches and Agent/FXP scheduling to reduce CPU, memory and process use.
- Fix traffic-cycle boundaries, multi-range port policies, loopback validation, custom HTML, Markdown links and capacity display.

### Versions

- Panel/APK release: 2.3.276; Agent: 2.2.190; ForwardX FXP runtime: 2.2.114; Android: 2.3.97.

## [2.3.275] - 2026-08-13

### Fixes and improvements

- Restore failover members by priority and switch back to higher-priority recovered members.
- Preserve previous state during rule-page refresh and fix ordinary-user entry-domain inconsistencies.
- Add GitHub download acceleration, installer support, deployment documentation and upgrade verification.

### Versions

- Panel/APK release: 2.3.275; Agent: 2.2.189; ForwardX FXP runtime: 2.2.113; Android: 2.3.97.

## [2.3.274] - 2026-08-09

### Added

- Support multiple simultaneous plans, combined entitlements and separate plan/manual/add-on traffic display.

### Fixes and improvements

- Fix resource reclamation, cycle display and Agent refresh after plan expiry, resets and renewals.
- Fix Agent/FXP traffic/connection accounting and improve UDP buffer cleanup and offline heartbeat retries.

### Versions

- Panel/APK release: 2.3.274; Agent: 2.2.188; ForwardX FXP runtime: 2.2.113; Android: 2.3.97.

## [2.3.273] - 2026-08-07

### Added

- Add resource speed limits to port forwarding, chains and groups across GOST, ForwardX, iptables, nftables, Realm, Socat and Nginx.

### Fixed

- Fix Agent offline decisions and DDNS failover delays, with bounded retries on failed transitions.
- Fix listener handover, restart recovery and state synchronization for ForwardX, mimic and failover.
- Fix monthly plan reset days, subsequent traffic cycles and recovery after over-quota suspension.
- Fix truncated long-range host latency charts, shifted time axes and initial display state.
- Allow deleting saved AI API keys.

### Versions

- Panel/APK release: 2.3.273; Agent: 2.2.187; ForwardX FXP runtime: 2.2.112; Android: 2.3.97.

## [2.3.272] - 2026-08-04

### Fixed

- Fix a WireGuard UDP shutdown deadlock between queue cleanup and the write loop.
- Fix older nftables parsing, forwarding-chain accepts and missing fallback after MASQUERADE failure.

### Versions

- Panel/APK release: 2.3.272; Agent: 2.2.186; ForwardX FXP runtime: 2.2.112; Android: 2.3.97.

## [2.3.271] - 2026-08-04

### Fixed

- Fix incomplete signed paths under mounted Agent/FXP report routes causing repeated 401 responses, and lost forced refreshes during busy probes.
- Repair confirmable historical group child/member/deletion leftovers that hide rules or block host deletion.
- Fix tunnel probe success reported with only exit results, stale results for missing first hops, tunnel timeout state and total latency display.
- Fix the WireGuard UDP queue-cleanup/write-loop shutdown deadlock.
- Fix older nftables parsing, forwarding-chain accepts and missing MASQUERADE fallback.

### Versions

- Panel/APK release: 2.3.271; Agent: 2.2.186; ForwardX FXP runtime: 2.2.112; Android: 2.3.97.

## [2.3.270] - 2026-08-04

### Fixed

- Stop reusing stale Agent/FXP processes after upgrades/configuration changes when forwarding works but traffic reports do not.
- Fix missing short-lived GOST/process connections leaving 24-hour counts at zero.
- Add FXP traffic-report throttling diagnostics and idempotent failed-batch retries.
- Fix early GOST/ForwardX UDP session closure and interrupted rebuilt sessions; reduce high-packet-rate overhead and bound queues/fragments.
- Use one bounded heartbeat retry queue and cancel retries immediately after any successful heartbeat.
- Fix pending-cleanup rules blocking Token deletion; show owning users for genuine rule conflicts.

### Versions

- Panel/APK release: 2.3.270; Agent: 2.2.184; ForwardX FXP runtime: 2.2.112; Android: 2.3.97.

## [2.3.269] - 2026-08-02

### Fixed

- Fix ordinary-user group traffic/connection ownership and cumulative Agent/FXP connection counts.
- Fix repeated restarts or counting interruptions during access-limit and TCP/UDP counting-chain recovery.
- Fix entry-port false conflicts and concurrent allocation during batch imports, copies and cross-group moves.
- Fix misleading “waiting for probe” tunnel segments and exit-group wording.

### Versions

- Panel/APK release: 2.3.269; Agent: 2.2.183; ForwardX FXP runtime: 2.2.111; Android: 2.3.97.

## [2.3.268] - 2026-08-01

### Added

- Separate plan and usage-billed traffic statistics and reset display baselines.
- Add custom-menu panel routes, embedded pages and new-window modes.
- Add tunnel/multi-entry latency details and troubleshooting screenshots.

### Fixed

- Fix Agent/FXP recovery/listener validation after restarts, upgrades and V1/V2/WireGuard/GOST transitions.
- Preserve firewall counters and avoid duplicate cleanup/count loss during recovery and rule repair.
- Fix topology matching, concurrent refresh, timeouts and stale-result reuse in tunnel/chain/multi-entry probes.
- Fix latency-node attribution, ordinary-user traffic display and custom-menu embedding.

### Versions

- Panel/APK release: 2.3.268; Agent: 2.2.182; ForwardX FXP runtime: 2.2.110; Android: 2.3.97.

## [2.3.267] - 2026-08-01

### Fixed

- Prevent payment callbacks reactivating closed orders, and enable PostgreSQL TLS certificate validation.

### Versions

- Panel/APK release: 2.3.267; Agent: 2.2.181; ForwardX FXP runtime: 2.2.110; Android: 2.3.97.

## [2.3.266] - 2026-07-30

### Added

- Allow correcting host cumulative traffic to a specified actual value.

### Fixed

- Fix six native GOST transports, UDP-only rule protocols and multi-hop relay authentication.
- Fix stale FXP state/authentication after switching to GOST, with transactional handover, rollback and recovery.
- Fix ordinary-user rule isolation and returning from empty filtered results.

### Improved

- Adjust host card/list actions, remove instantaneous traffic animations and clarify Token creation times.

### Versions

- Panel/APK release: 2.3.266; Agent: 2.2.181; ForwardX FXP runtime: 2.2.110; Android: 2.3.97.

## [2.3.265] - 2026-07-30

### Fixed

- Stabilize Agent handover, listener readiness and recovery between ForwardX V1/V2, WireGuard and GOST/Nginx.
- Support independent host port ranges per chain member; fix synchronization rollback, probes and traffic ownership.
- Verify Docker images and running versions before reporting a successful upgrade.
- Build/verify native amd64/arm64 images before merging manifests to avoid missing ARM64 images after QEMU failures.
- Fix occasional duplicate tunnel-latency queries at timeout boundaries.

### Versions

- Panel/APK release: 2.3.265; Agent: 2.2.180; ForwardX FXP runtime: 2.2.110; Android: 2.3.96.

## [2.3.264] - 2026-07-29

### Added

- Support drag/drop or multi-file upload of Nginx Stream PEM certificate chains and private keys.

### Fixed

- Fix memory, connection and stale-state cleanup for V1/V2 sessions, queues, handshakes and rule replacement.
- Fix Nginx Stream TCP long-connection timeouts, entry certificates and stale-certificate cleanup; add session diagnostics.

### Improved

- Optimize large merged V1/V2 entry configurations to reduce Agent CPU/GC overhead.
- Improve Token notes and standardize tunnel probe timeout messages.

### Validation

- Type checks, frontend build, Agent/FXP tests, race tests and go vet passed.

### Versions

- Panel/APK release: 2.3.264; Agent: 2.2.179; ForwardX FXP runtime: 2.2.110; Android: 2.3.96.

## [2.3.263] - 2026-07-29

### Fixed

- Fix stale state, incorrect cleanup and unready WireGuard peers with FXP multi-entry and mixed V1/V2.
- Stabilize group health switching against brief timeouts and panel communication fluctuations.
- Fix inconsistent permissions during revocation, migration and usage billing, and prevent stale cleanup deleting a new rule on the same port.
- Separate port-forwarding and network-test host permissions; hide unauthorized underlying hosts.
- Preserve last valid domain addresses on expiry/DNS failures to avoid repeated resolution and runtime churn.
- Fix duplicate, mixed or missing traffic accounting across iptables, nftables, Realm, Socat, GOST, Nginx and ForwardX.
- Reduce firewall counter scanning/rebuilds with large rule sets, DNS changes and Agent restarts; support Alpine/BusyBox.

### Validation

- Server tests 427/427, Agent/FXP tests, types, production and documentation builds passed. Docker builds were not run.

### Versions

- Panel/APK release: 2.3.263; Agent: 2.2.178; ForwardX FXP runtime: 2.2.109; Android: 2.3.96.
