# Changelog

[简体中文](CHANGELOG.md) | [English](CHANGELOG.en.md)

## [2.3.291] - 2026-10-26

- Report host TCP/UDP socket counts from Agents and display them in the host list.
- Improve restricted-LXC traffic accounting with native GOST and existing Guard fallbacks; update both panel and Agent.
- Reset displayed port-resource traffic without affecting usage or billing; retain manual sync.
- Show self-test results as they arrive while pending parts continue, improving multi-entry diagnostics.
- Redesign host and rule globes and strengthen consistent card hover effects.
- Reduce resource usage in logging, setup queries, Agent queues and service checks; harden commands and sign-in security.
- Panel `2.3.291`; Android / iOS `2.4.9`; Agent `2.2.204`; ForwardX FXP runtime `2.2.122` (unchanged).

## [2.3.290] - 2026-10-24

- Use categorized dropdowns and single-column bulk workflows; add enable, pause, restart, delete, personal-group filters and failed-item retries. Restarts preserve paused states and statistics.
- Filter grouping candidates by add/remove action and target groups; align controls, stabilize initial loading and fix pagination/Apply to the footer.
- Import port ranges, lists and per-line `listener:target:port`; re-import TXT exports with listener ports and failed items preserved.
- Add a searchable AI model picker with refresh and custom input; fix DeepSeek model-list requests.
- Fix same-token replacement recovery. New Agents take ownership; updated retired instances stop syncing while preserving forwarding. Confirm copying linked installation commands.
- Move resource alerts to a dedicated service-management tab; select CPU, memory or disk per service, with all/specific/excluded hosts and administrator-only notifications.
- Fix clipping, blocked scrolling, crowded chart titles and overlapping metered controls in mobile dialogs; respect safe areas and browser-toolbar heights.
- Add mobile sidebar swipes, refine dashboard cards and host actions, and remove unnecessary settings gaps.
- Keep plans and metered resources card-only with drag sorting; improve narrow upgrade cards, version labels and statistics.
- Avoid redundant group-maintenance writes and batch member-host reads while preserving configuration sync and online recovery dispatch.
- Panel `2.3.290`; Android / iOS `2.4.8`; Agent `2.2.203`; ForwardX FXP runtime `2.2.122`. Same-token ownership requires matching Agent / FXP updates.

## [2.3.289] - 2026-10-23

- Compact operations ranking cards to fit their content; preview five entries and view the top ten in a dialog to reduce empty space.
- Add plan and metered-resource stock with sold-out visibility and ∞ for unlimited supply. Metered stock is per user, with per-user rule limits and release after all logical rules are deleted; transactional checks prevent overselling.
- Add short-lived display caches, request coalescing and bounded read queues, with write invalidation and per-user isolation.
- Give metered-plan descriptions the same Markdown/HTML editor, preview, templates and length limit as subscription plans.
- Address soft text in the forwarding-rule All view by removing persistent layer hints and duplicate card scaling while preserving expand/collapse transitions.
- Add custom metered-plan names in management and the store, falling back to resource names when blank.
- Show today's traffic on the left and cumulative traffic on the right of link-management cards, with days starting at 00:00 UTC+8.
- Fix initialization stalls during installation or upgrades on some MySQL 8.0 servers.
- Fix incorrect UDP reply source addresses in Agent-managed forwarding on multi-IP hosts; preserve the actual entry IP and separate sessions targeting different local IPs. Requires an Agent update.
- Fix text wrapping in narrow balance and promotion cards; give toggles a separate row and adapt the card grid to available width.
- Move the payment master switch into the top status card and remove its duplicate basic-settings section.
- Unify hover feedback across host, rule, overview and plugin cards with softer shadows and smoother transitions.

- Versions: panel `2.3.289`, Android / iOS `2.4.7`, Agent `2.2.202`, ForwardX FXP runtime `2.2.121`. Update the Agent for the multi-IP UDP fix.

## [2.3.288] - 2026-10-22

- Add scheduled operations reports with separate editable hour/minute dropdowns through the active notification channel; disabled by default, with a default send time of 00:00 UTC+8.
- Add counts to host, group, Token and service tabs, refreshed after additions and deletions.
- Preserve the current route title and tab-local navigation appearance during refresh; fix collapsed sidebar label clipping without caching authentication or access decisions.
- Compact tunnel card routes and protocols into one row; open entry/relay/exit details in a dialog and hop latency in a popover to avoid uneven rows and blank space.
- Show overall health in resting date blocks and intraday stability trends on hover/focus; preserve coverage gaps and add local outage/recovery/probe fixtures.
- Compact service/probe history into status blocks that expand to reveal dates on hover; use a dropdown on mobile and respect personal animation preferences.
- Fill today's service-latency chart from midnight to the current time, removing future blank space while keeping historical days complete.
- Show counts on all six link-management tabs, scoped to account permissions and search, and refresh after resource changes.
- Fix intermittently missing multi-entry tunnel latency with more frequent tunnel reports, independent live-sample refresh, restart warm-up and asynchronous hop details; requires an Agent update.
- Resume setup automatically after database-switch restarts, keep checking in the background, and match the initial database choice to the server dialect.
- Localize unsupported MySQL versions and unauthorized client hosts in setup status, connection tests and database saves.
- Remove Python and sysctl command dependencies from the BBR plugin using built-in Agent management, preserving validation, backups and rollback; requires the updated Agent.
- Keep rule card styling and switch positions stable across personal-group filters; reserve consistent control space and release idle sortable compositing layers.

- Versions: panel `2.3.288`, Android / iOS `2.4.6`, Agent `2.2.201`, ForwardX FXP runtime `2.2.121`. Update the Agent for built-in BBR management and probe-reporting improvements.

## [2.3.287] - 2026-10-21

- Make affiliate management, referral and operations pages fill the dashboard content width.
- Add author support under Open Source & Contact in Settings, with the README's wallet addresses and copy actions.
- Fix clipped card shadows in rules, host management and public monitoring while preserving hover and group disclosure effects.
- Add private rule groups with multi-group assignment, direct member selection, sorting and bulk editing; align card route/protocol/group badges in one row with a separate path; add a configurable group column, with Ungrouped last.
- Add floating horizontal scrollbars to wide host, rule, tunnel and forwarding-group lists without scrolling to the table bottom.
- Decrypt V1 forwarding frames in place with pooled buffers to reduce allocations and GC; skip payload pre-reads without PROXY reception to avoid a roughly 150ms delay for server-first connections.
- Add the official BBR manager with per-host parameters, visual/text editing, BBR + FQ preset and restore; add BBR and Live2D logos.
- Move rule quotas to an optional column and show card quota details in an info popover without increasing row or card height.
- Fill host and rule tables to the container width, using the last visible column to remove trailing blank space.
- Keep list settings panels within the available viewport height with scrollable options.
- Add per-account host list columns, ordering and resizable widths; split details for shorter rows and remove pinned edge columns and shadows.
- Prevent squeezed status badges and switches in link resource tables.
- Fix clipped dialog content and unreachable save actions in short browser windows.
- Fix invisible dialogs, blocked interactions and overridden drag transforms when interface animations are disabled.
- Save rule list columns, order and widths per account; compact quota and resource traffic summaries to prevent oversized rows.
- Keep the dashboard online indicator steady during background refreshes and give the date a subtle, theme-aware style.
- Add host URL connection checks with HTTP/HTTPS, timeout and status validation, measuring fresh-connection time to first byte (requires an Agent update).
- Fix custom branding and sidebar flashes on refresh, and overlapping confirmation actions in Chinese and English.
- Move per-host resource alert configuration and notification recipients to service management; show alerts, China health status and IP switch history at the bottom of Operations.
- Add a default-on, per-account animation switch in Profile to disable transitions, hover, list and chart animations.
- Compact host, rule, tunnel, plan, billing, reminder and settings forms: pair short fields on mobile while preserving space for long content; move switch guidance to hover/focus hints and disable unavailable controls.
- Add 1/5/15-minute load to host management and public monitoring: CPU tooltip in compact cards, CPU section in standard cards, and below region in lists (requires an Agent update).
- Scope traffic queries and resource loading by user; refresh home/operations summaries in the background and remove duplicate session lookups.
- Add isolated synthetic-data load tests and a local bottleneck report without touching development or production data.
- Combine host reminders and simplify copy; add opt-in traffic-threshold shutdown with a once-per-cycle guard (Agent update required).
- Move dashboard date/user filters and traffic summaries to the top.
- Fix ticket and affiliate sidebar visibility switches; align affiliate labels in admin navigation and settings.

- Versions: panel `2.3.287`, Android / iOS `2.4.5`, Agent `2.2.200`, ForwardX FXP runtime `2.2.121`. URL checks and V1 optimizations require an Agent/runtime update.

## [2.3.286] - 2026-10-19

- Fix Android build collisions from precompressed web assets; support repairing a missing release APK independently.
- Sync Android/iOS launcher icons with preset themes and light/dark mode; unify the default logo.
- Keep the browser-tab icon in sync with the panel theme and custom logo.
- Use two-column CAPTCHA settings with administrator-selected click verification or obfuscated image challenges, enforced server-side.
- Load only the current page on startup and prefetch on menu intent; preserve navigation and upgrade state without full-screen loading overlays.
- Add styled Excel billing exports for all/selected users (admins) or the current user's own ledger.
- Refine host editing and compact DDNS controls; add service-mode tabs and shorten health-check copy with collapsible help.
- Discover multiple public IPv4/IPv6 addresses with separate primary selections; add dual-stack DDNS and primary-only/all-address synchronization.
- Add China connectivity checks to host services: sustained failures trigger notifications and Agent-side private HTTP/HTTPS IP-switch APIs without reply confirmation, with cooldowns, rate caps, replay protection and address sync.
- Add exact AI user counts and actual traffic rankings with entity, date, direction and permission filters.
- Add administrator-only, read-only external MCP access in AI settings with expiring/revocable tokens, permission checks and rate limits.
- Add Ping summaries, route-hop visualization and host/rule configuration checks to Network Test.
- Add global resource status, security configuration checks and opt-in sustained resource alerts with recovery events and notifications.
- Retry FXP connection/hello setup on other candidates before business payload; fix same-port endpoint identity. Established-stream relay resumption is not included.
- Add persistent drag sorting for subscription plans and metered resources in card and table views, with matching store order.
- Default the rule list to My Rules instead of restoring the previous user filter.
- Fix rule drag sorting being disabled after selecting a category.
- Reposition map hover details to keep the active region visible.
- Speed up first and repeat visits; show cached dashboard data while sections refresh independently.
- Refresh login and registration with smooth transitions, a themed language selector and a cleaner layout for mobile, both languages and light/dark themes.
- Fix duplicate logos in the public homepage header.
- Improve legacy database upgrades and history cleanup to avoid startup blocking and clearly report migration failures.
- Clarify database errors with actionable access, permission and upgrade guidance.
- Show rule names instead of bare IDs in Operations traffic rankings.
- Center switch shadows to improve visual alignment.
- Check source-traffic dependencies and enable verified connection accounting during Agent installation and script upgrades, with clear failure warnings.
- Run panel health checks in the background without a full-screen refresh interstitial; retain outage diagnostics and recovery checks while avoiding duplicate startup requests.
- Fix stale multi-entry tunnel latency results and failed entries showing as untested; improve per-hop diagnostics.

- Versions: panel `2.3.286`, Android / iOS `2.4.4`, Agent `2.2.199`, ForwardX FXP runtime `2.2.120`. Multi-IP discovery and automatic IP switching require an Agent upgrade; launcher theme sync requires an App update.

## [2.3.285] - 2026-10-17

- Support entry groups for direct port forwarding, with unified management and all entries running concurrently.
- Simplify plan management: remove overview cards, move global switches into a settings dialog, and keep financial reporting in Billing and Operations.
- Use icon-only plan edit actions; support safe HTML / Markdown descriptions, preview and a starter template, with a 10,000-character limit.
- Use consistent colorful statistic icons in affiliate administration and user commission overviews.
- Color-code Operations and payment metrics and unify hover feedback on statistic and product cards, respecting touch devices and reduced-motion preferences.
- Move affiliate settings and the feature switch into the top-right settings dialog; separate sidebar visibility and preserve the existing enabled state.
- Add a ticket management settings dialog for feature and notification master switches; keep sidebar visibility independent and preserve history and personal notification preferences.
- Reload the development backend after code changes while preserving debug data to prevent missing ticket-settings APIs; hide switch states when settings cannot be loaded.
- Fix the sticky top navigation disappearing while dropdowns are open by unifying overlay scroll locking.
- Align port-entry group cards and lists with forwarding-chain layouts; show node details in a dialog without stretching adjacent cards.
- Keep panel upgrade polling and completion countdowns active in the background; preserve refresh deadlines across navigation and refresh each task only once.
- Add resource traffic totals and per-entry runtime status; include tunnel traffic and unique rule-reference counts for tunnels, chains, entry groups and exit groups.
- Add ny / Nyanpass rule import (Experimental).
- Add an operations dashboard for billing, traffic history, source IP rankings and an offline map; include static payment, wallet-spending and order-status donut charts with separate currencies.
- Add 5s / 10s / 30s / off auto-refresh options; pause when off-page or hidden.
- Fix scheduled history cleanup failures on some MySQL deployments.
- Fix EasyPay signing, relative payment links and Alipay timestamps; improve key compatibility, WeChat settings, response verification and merchant identity checks.
- Unify recharge/renewal checkout and fulfillment states; add active reconciliation, verified late-payment recovery and localized payment diagnostics.
- Consolidate orders into Billing & Redemption with server-side ledger/balance pagination and preserved payment diagnostics.
- Add per-host online/offline notification switches, enabled by default, without affecting monitoring or failover.
- Preserve sidebar scroll position; use searchable, paginated user selectors with an initial list for quick selection.
- Improve error messages, automatic retries and panel/Agent diagnostic logs.
- Fix host-dependency navigation and rechecks so linked resources are not mistaken for missing ones.
- Smooth settings save feedback to reduce flicker and layout shifts.
- Remove disabled legacy filtering, unused components, duplicate installer code and Android sample tests; retain required data migration compatibility.
- Consolidate documentation and navigation; document payments, billing/redemption, operations and new workflows with local demo screenshots.
- Improve V3 tunnel stability, security and multi-exit failover; V3 is not yet available in the panel.
- Versions: panel `2.3.285`, Android / iOS `2.4.3`, Agent `2.2.198`, ForwardX FXP runtime `2.2.119`.

Upgrade note: V3 entry and exit must be upgraded together; older V3 runtimes are incompatible. V1/V2 protocols remain compatible.

## [2.3.284] - 2026-10-13

- Add optional affiliates and support tickets, with global/per-user ticket notification switches for Telegram / Discord.
- Retain latency and host availability history for 30 days, with color-coded daily navigation, hover statistics, offline details and a Today shortcut; optimize indexes, queries and batched cleanup.
- Support SOCKS/HTTP proxies for Agent installation, management traffic and upgrades. Add the `fwxm` SSH menu for status, restart, logs, proxies, repair and panel admin password recovery. Proxies cover management/downloads, not forwarded traffic.
- Refine dashboard, sidebar, mobile safe areas and numeric displays; provide 20 local avatars and show cancelled plans only in billing.
- Correct active-member forwarding-group link tests and stale child-rule references, preserving real dependencies and Agent cleanup acknowledgements.
- Reorganize both READMEs and deployment guides, including proxy, SSH management, upgrade, backup and recovery instructions.
- Versions: panel `2.3.284`, Android / iOS `2.4.2`, Agent `2.2.197`, ForwardX FXP runtime `2.2.118` (unchanged). Agent proxy support requires an Agent upgrade; upgrades are not guaranteed to preserve active connections.

## [2.3.283] - 2026-10-12

- Refresh themes, cards and transitions; simplify help and pagination, improve dark/light and mobile layouts, and retain the React architecture.
- Complete English UI, theme and wallpaper labels; fix language switching, header alignment and hot-update dialog errors; reorder Google sign-in settings.
- Fix mismatched rule search counts/results, improve host removal and stale-reference/notification cleanup, and let custom plan descriptions replace defaults.
- Add GOST and V1/V2 tunnel rules incrementally to reduce disruption to existing connections; port conflicts preserve existing rules.
- Support per-source-IP TCP connection limits for ordinary forwarding, shared per user and entry host. UDP is excluded; update the Agent.
- Reorganize deployment and usage docs, clarify traffic/probe statistics, and verify GitHub Pages publication.
- Versions: panel `2.3.283`, Android / iOS `2.4.1`, Agent `2.2.196`, ForwardX FXP runtime `2.2.118`. Incremental tunnel updates require matching Agent/runtime upgrades; the upgrade itself is not guaranteed connection-preserving.

## [2.3.282] - 2026-10-07

### Features and configuration

- Add an administrator-controlled sign-in/sign-up human-verification switch, enabled by default. Disabling it hides the widgets and skips only CAPTCHA checks on the server, preserving passwords, sign-in rate limits, email verification and 2FA. Include Chinese/English UI and HTTP compatibility guidance. Advance Android to `2.4.0` so installed clients detect this UI update.
- Fix iOS IPA icon generation with a supported 32-bit CoreGraphics context and opaque PNG export. Add an actual macOS rendering regression test and actionable errors instead of a Swift crash.

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

- Panel and APK release: 2.3.282; Android app: 2.4.0; iOS app: 1.0.0; Agent: 2.2.195; ForwardX FXP runtime remains `2.2.117`.
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
