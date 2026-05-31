# Changelog

## [2.3.74] - 2026-05-31

### Changed

- Switched generated user avatars to Multiavatar and migrated legacy `preset:` avatar values to the new `multiavatar:` format.
- Applied the 3 successful avatar changes per day limit only to normal users; administrators are no longer limited by the daily avatar quota.
- Added a random-avatar generation rate limit of 10 requests per minute.
- Moved Profile into the Management sidebar group for both administrators and normal users.
- Limited the Profile software update card to Android APP environments; Web panel updates remain under System Settings.
- Fixed APP update version display so versions are not shown with a duplicated `v` prefix.
- Bumped panel version to 2.3.74. Agent target version remains 2.2.66.
- Bumped Android APP version to 2.3.28 so the APK includes the latest profile and avatar updates.

## [2.3.73] - 2026-05-31

### Added

- Added configurable site title/logo branding and user avatars with preset/random/custom upload support.
- Added a dedicated Profile page for avatar, password, Telegram binding, 2FA, software update, and logout actions.

### Changed

- Moved account security and binding settings into Profile while keeping the sidebar account menu focused on Profile, software update, and logout.
- Limited self-service avatar changes to 3 times per user per day, with random avatar updates handled by the backend.
- Improved mobile/APP account, payment, billing, traffic-billing, and plan-management layouts so key fields fit without horizontal scrolling.
- Bumped panel version to 2.3.73. Agent target version remains 2.2.66.
- Bumped Android APP version to 2.3.27 so the APK includes the latest Profile and mobile UI updates.

## [2.3.72] - 2026-05-31

### Fixed

- Cleared stale Agent upgrade states from host lists when an Agent has already reported the requested target version.
- Allowed Agent release asset checks to fall back to direct GitHub Release download URLs when the GitHub API is rate limited.
- Added an Agent self-upgrade lock timeout so a failed upgrade launcher cannot permanently block later upgrade retries.

### Changed

- Bumped panel version to 2.3.72 and Agent target version to 2.2.66.
- Bumped Android APP version to 2.3.26 so the APK includes the latest mobile UI layout fixes.

## [2.3.70] - 2026-05-31

### Fixed

- Bumped the Agent target version to 2.2.65 so upgraded Agents no longer report a version inside the legacy panel-versioned Agent range and can clear the pending upgrade state normally.

### Changed

- Bumped panel version to 2.3.70 and Agent target version to 2.2.65.

## [2.3.69] - 2026-05-31

### Fixed

- Optimized Billing and redemption/discount code lists for mobile APP screens with card-style rows so all ledger, validity, usage, and action fields are visible without horizontal scrolling.
- Optimized Traffic Billing configuration and deduction records for mobile APP screens, including wrapping long stat values and resource details.
- Optimized Plan Management package and subscription lists for mobile APP screens, keeping price, resources, limits, status, and actions visible on narrow screens.

### Changed

- Bumped panel version to 2.3.69. Agent target version remains 2.2.63.

## [2.3.68] - 2026-05-31

### Fixed

- Improved mobile dashboard and user-management traffic summary cards so large traffic values wrap and display completely instead of being truncated with ellipses.
- Hid decorative stat icons on small screens and let inbound/outbound traffic cards span the full mobile width for better APP readability.
- Allowed subscription traffic and addon traffic values in user management to wrap instead of being clipped on narrow screens.

### Changed

- Bumped panel version to 2.3.68. Agent target version remains 2.2.63.

## [2.3.67] - 2026-05-31

### Fixed

- Allowed existing multi-hop tunnels to switch between GOST and ForwardX custom-encryption runtimes during edit, with all hop Agents refreshed so the new runtime is applied.
- Added Agent-side tunnel port runtime state and stale FXP cleanup so switching a multi-hop tunnel between GOST and ForwardX clears the old listener before applying the new one.
- Stopped requiring or starting `gost` for the managed tunnel service when a host has no active GOST tunnel services, so plain iptables/nftables forwarding does not start GOST.
- Improved the multi-hop tunnel editor on mobile/app screens so hop rows wrap cleanly and the edit dialog remains scrollable on small viewports.

### Changed

- Bumped panel version to 2.3.67 and Agent target version to 2.2.63.

## [2.3.66] - 2026-05-30

### Fixed

- Forced the Agent to clear stale local runtime before applying a rule when the same port switches to another forwarding type, including old managed services, iptables NAT rules, nftables rules, and traffic baselines.
- Removed connection/IP limit enforcement from direct port forwarding apply paths while keeping the cleanup in place for stale limit chains; tunnel forwarding still keeps those user access controls.
- Split socat apply commands into startup prerequisites and non-critical post-start traffic/accounting commands so a working socat service is no longer reported as not running just because counter setup fails.
- Switched iptables traffic accounting to direct mangle counter rules so reverse tests such as `iperf3 -R` avoid the old per-packet jump through `FWX_IN/FWX_OUT` chains.
- Moved nftables traffic accounting to dedicated mangle-priority direct counters so client upload traffic, such as `iperf3 -c <host> -p <port>`, is counted continuously as inbound traffic on the forwarding host without an extra per-packet jump through per-rule counter chains.

### Changed

- Bumped panel version to 2.3.66 and Agent target version to 2.2.62.

## [2.3.65] - 2026-05-30

### Fixed

- Kept forwarding rule self-test dialogs in the testing state until the newly queued test result is returned, preventing stale previous results from restoring the button too early or leaving the UI stuck.
- Kept tunnel self-test dialogs in the testing state until the server reports the new pending/completed result, so the visible status matches the active test run.

### Changed

- Bumped panel version to 2.3.65. Agent target version remains 2.2.61.

## [2.3.64] - 2026-05-30

### Fixed

- Added panel logs for direct forwarding rule self-test queue, result, and timeout events so stuck tests show their rule, host, and reason.
- Normalized Agent action `statusType` values before dispatch so plain rule actions no longer log an empty status type.

### Changed

- Bumped panel version to 2.3.64. Agent target version remains 2.2.61.

## [2.3.63] - 2026-05-30

### Fixed

- Enabled GOST relay handler `nodelay` on tunnel middle-hop and exit services so relay connectors no longer wait on a response that is buffered behind downstream TLS/application data.

### Changed

- Bumped panel version to 2.3.63. Agent target version remains 2.2.61.

## [2.3.62] - 2026-05-30

### Fixed

- Restored GOST relay `nodelay` metadata to a boolean value and ensured middle-hop relay services stay in proxy mode without a fixed forwarder.
- Added GOST config summary and restart diagnostics to Agent command output for tunnel troubleshooting.

### Changed

- Bumped panel version to 2.3.62. Agent target version remains 2.2.61.

## [2.3.61] - 2026-05-30

### Fixed

- Removed the leftover GOST multi-hop relay forwarder that sent middle-hop traffic to the generic tunnel probe port instead of allowing the entry chain to reach the rule-specific exit port.
- Made GOST relay metadata and exit target forwarding more explicit for better compatibility and diagnostics.

### Changed

- Bumped panel version to 2.3.61. Agent target version remains 2.2.61.

## [2.3.60] - 2026-05-30

### Fixed

- Reverted GOST multi-hop business routing to use the existing hop listener ports instead of new rule-specific relay ports that may be blocked by host firewalls.
- Serialized Agent action execution so concurrent tunnel/rule applies no longer race while writing GOST configs and restarting services.

### Changed

- Bumped panel version to 2.3.60 and Agent target version to 2.2.61.

## [2.3.59] - 2026-05-30

### Fixed

- Routed GOST multi-hop business traffic through per-rule relay ports so middle hops forward to the correct rule-specific exit port instead of the generic tunnel probe port.

### Changed

- Bumped panel version to 2.3.59. Agent target version remains 2.2.60.

## [2.3.58] - 2026-05-30

### Fixed

- Changed GOST multi-hop relay generation so the entry rule dials only the first relay and each relay service explicitly forwards to the next hop or exit.

### Changed

- Bumped panel version to 2.3.58. Agent target version remains 2.2.60.

## [2.3.57] - 2026-05-30

### Fixed

- Fixed Agent tunnel actions with `rule=0` overwriting per-port rule traffic state on GOST multi-hop relay ports.
- Enabled `nodelay` on GOST relay connectors so multi-hop tunnel connections do not stall while waiting for client request data.

### Changed

- Bumped panel version to 2.3.57 and Agent target version to 2.2.60.

## [2.3.56] - 2026-05-30

### Fixed

- Added non-billing GOST multi-hop relay traffic sampling so middle hop Agents report `[TunnelTraffic]` diagnostics for active tunnel rules.
- Kept GOST tunnel traffic billing on the exit host only to avoid double-counting usage across multi-hop relays.

### Changed

- Bumped panel version to 2.3.56. Agent target version remains 2.2.59.

## [2.3.55] - 2026-05-30

### Fixed

- Forced GOST multi-hop forwarding rules to include the exit rule port as the final chain hop so entry services no longer dial the exit directly outside the hop chain.

### Changed

- Bumped panel version to 2.3.55. Agent target version remains 2.2.59.

## [2.3.54] - 2026-05-30

### Fixed

- Refreshed every host in a multi-hop tunnel when forwarding rules are created, updated, toggled, deleted, or self-tested so middle relay Agents receive the current topology.
- Treated stale successful removal reports for already-deleted rules as idempotent instead of returning `rule not found`.

### Changed

- Bumped panel version to 2.3.54. Agent target version remains 2.2.59.

## [2.3.53] - 2026-05-30

### Fixed

- Fixed multi-hop tunnel drag reordering so changed hop order is saved immediately and triggers a full runtime refresh.
- Preserved existing hop listener ports when reordering multi-hop tunnels so updated routes replace the old topology cleanly.
- Added tunnel ids to panel rule-status logs and route diagnostics for GOST multi-hop rules.

### Changed

- Bumped panel version to 2.3.53. Agent target version remains 2.2.59.

## [2.3.52] - 2026-05-30

### Fixed

- Added Agent log level summaries and independent Agent log filtering in system settings.
- Fixed GOST tunnel forwarding rule actions so Agent logs and status reports include the tunnel id.

### Changed

- Bumped panel version to 2.3.52. Agent target version remains 2.2.59.

## [2.3.51] - 2026-05-30

### Fixed

- Fixed multi-hop tunnel refreshes so all hop hosts are refreshed on tunnel updates instead of only the entry and exit hosts.
- Fixed multi-hop tunnel runtime status so the tunnel is marked running only after every hop host reports a successful apply.

### Changed

- Bumped panel version to 2.3.51. Agent target version remains 2.2.59.

## [2.3.50] - 2026-05-30

### Fixed

- Fixed GOST multi-hop forwarding so entry rules use intermediate hops as the chain and the exit rule port as the final forwarder target.

### Changed

- Bumped panel version to 2.3.50. Agent target version remains 2.2.59.

## [2.3.49] - 2026-05-30

### Changed

- Moved forwarding and tunnel self-test failure details out of the dialog body and into bottom-right notifications.
- Bumped panel version to 2.3.49. Agent target version remains 2.2.59.

## [2.3.48] - 2026-05-30

### Fixed

- Fixed tunnel latency self-tests getting stuck in `pending` when an Agent did not report back before the timeout window.
- Prevented repeated tunnel latency self-test clicks while a test is already running.
- Prevented established multi-hop tunnels from switching between GOST and ForwardX custom-encryption runtime families; delete and recreate the tunnel instead.

### Changed

- Added a confirmation dialog before bulk one-click Agent upgrades are dispatched.
- Bumped panel version to 2.3.48. Agent target version remains 2.2.59.

## [2.3.47] - 2026-05-30

### Fixed

- Prevented regular port forwarding rules from being edited directly onto a different entry host.
- Allowed tunnel forwarding rule edits to switch to tunnels with different entry hosts by rebinding the rule to the selected tunnel entry.
- Added Agent runtime handoff and bind-owner logs to diagnose GOST/ForwardX tunnel switching on reused entry ports.
- Fixed panel one-click upgrades when the latest version is detected from `main` before a matching release tag exists.

### Changed

- Bumped panel version to 2.3.47 and Agent target version to 2.2.59.

## [2.3.46] - 2026-05-30

### Fixed

- Fixed switching a multi-hop tunnel from GOST to ForwardX so old GOST tunnel services are stopped before FXP binds the same tunnel ports.
- Fixed Agent FXP startup reporting so immediate runtime exits, such as port bind failures, are reported as failed instead of `ok=true`.

### Changed

- Bumped panel version to 2.3.46 and Agent target version to 2.2.58.

## [2.3.45] - 2026-05-30

### Added

- Added one-click batch Agent upgrade from host management.
- Added optional Agent key-log upload with per-host and aggregate viewing in the logs page.

### Fixed

- Fixed automatic tunnel latency collection for multi-hop tunnels to aggregate fresh per-hop TCPing results instead of storing only the entry-to-next-hop latency.
- Fixed forwarding rule TCPing stats for tunnel rules to store tunnel latency plus exit-to-target latency, matching the manual self-test path.
- Reset and refresh old and new multi-hop hosts when tunnel hop topology changes so existing forwarding rules resync cleanly.

### Changed

- Bumped panel version to 2.3.45 and Agent target version to 2.2.57.

## [2.3.44] - 2026-05-30

### Fixed

- Fixed GOST multi-hop forwarding rules so the entry rule chain dials the configured middle hops directly and lands on the rule-specific tunnel exit port.
- Fixed tunnel forwarding rule self-tests to report estimated full-path latency from tunnel-hop latency plus exit-to-target latency, instead of only TCPing the entry listener.

### Changed

- Bumped panel version to 2.3.44 and Agent target version to 2.2.56 so GitHub Release assets can be used for machine updates.

## [2.3.43] - 2026-05-30

### Fixed

- Fixed GOST multi-hop tunnel rules so entry chains traverse every configured hop and land on the rule-specific tunnel exit port instead of the tunnel probe port.
- Fixed tunnel forwarding rule self-tests to prefer entry-port end-to-end probing instead of estimating latency from exit-to-target checks plus tunnel hop probes.
- Limited multi-hop tunnels to a maximum of five hosts from both the UI and server validation.

### Changed

- Bumped panel version to 2.3.43. Agent target version remains 2.2.55.

## [2.3.42] - 2026-05-30

### Fixed

- Fixed ForwardX multi-hop tunnels so rule traffic enters the configured hop chain instead of bypassing relay nodes.
- Fixed FXP relay downstream encryption handshakes to use the relay segment key, restoring data forwarding through multi-hop relay chains.
- Allowed intermediate tunnel hop Agents to report tunnel runtime status.

### Changed

- Bumped panel version to 2.3.42 and Agent target version to 2.2.55.

## [2.3.32] - 2026-05-30

### Added

- Target addresses now support domain names in addition to IP addresses. The heartbeat handler resolves domains to IPs on each cycle and automatically re-applies forwarding rules when the resolved IP changes, ensuring forwarding stays online through DNS migrations.
- Forwarding rules that use user-space proxies (realm, socat, gost) now show an amber notice in the UI that connection and IP counts are conntrack-based approximations.

### Fixed

- Fixed Go Agent connection count reporting that was storing absolute conntrack snapshot values instead of deltas, causing massively inflated connection totals in the dashboard.
- Fixed counting chain traffic undercount in the shell-based Agent by removing it entirely and requiring the Go Agent binary for all installations. The Go Agent reads all five mangle hook points and takes the maximum to avoid double-counting.
- Cleaned up stale filter-table cleanup commands in the server-side counting chain removal logic.

### Changed

- Rewrote the one-click install script as a self-contained Go Agent installer. The legacy shell-based Agent has been retired.
- Bumped panel version to 2.3.32 and Agent target version to 2.2.53.

## [2.3.31] - 2026-05-29

### Fixed

- Fixed inbound and outbound traffic accounting across iptables, nftables, realm, socat, gost, and tunnel forwarding paths.
- Fixed ForwardX encrypted tunnel traffic reporting to count real forwarded payload bytes instead of relying on outer tunnel socket counters.

### Changed

- Bumped panel version to 2.3.31 and Agent target version to 2.2.52.

## [2.3.30] - 2026-05-28

### Fixed

- Fixed Agent reconnect handling after upgrades so tunnel and forwarding runtime state can recover without manually toggling entries.
- Fixed latency chart scaling so low-latency data no longer gets forced into an oversized 120ms range.
- Unified dashboard page spacing and tab/type control spacing across management pages.

### Changed

- Renamed system setting labels from system information to system configuration and changed one-click install wording to installation instructions.
- Bumped panel version to 2.3.30. Agent version remains 2.2.51.

## [2.3.29] - 2026-05-28

### Added

- Added card/table view switching for tunnel management, forwarding rules, and forwarding groups.

### Fixed

- Fixed settings save buttons flashing through a temporary saving label by keeping button text stable and showing saved status via toast messages.
- Fixed the first-load and refresh loading spinner animation so it completes smooth rotations.
- Improved billing and traffic-billing stat card alignment to match the user management layout.
- Fixed Agent upgrade asset checks to verify Agent binaries from the panel release tag where they are actually published.
- Clarified the system settings tab boundary with a stronger framed tab strip.

### Changed

- Bumped panel version to 2.3.29 and Agent target version to 2.2.51.

## [2.3.22] - 2026-05-28

### Fixed

- Hid forwarding-group navigation and rule controls from regular users while keeping admin access intact.
- Fixed traffic-billed tunnel users being unable to add forwarding rules when they do not also have direct host permissions.
- Unified the first-load and in-app loading screens on the Android APK logo and simplified the loading text to avoid flicker.

### Changed

- Bumped panel version to 2.3.22. Agent version remains 2.2.49.

## [2.3.11] - 2026-05-26

### Added

- Added browser-local persistence for the host management card/list view mode.
- Added Agent Token bound-host display and now use the Agent Token remark as the default name for newly registered hosts.
- Added a repository fallback release keystore so GitHub Actions can build signed Android release APKs when private signing secrets are not configured.

### Changed

- Reworked the add forwarding rule route selector into a compact segmented control for port forwarding, tunnel forwarding, and forwarding groups.
- Changed automatic panel update checks to only run on backend visits or browser refreshes, with a 1-minute cache interval.
- Changed the sidebar upgrade flow so confirming an upgrade starts it in the background, keeps progress visible in the lower-left area, and refreshes the browser after the upgraded panel comes back.
- Updated web introduction wording to "ForwardX转发管理面板".
- Bumped panel version to 2.3.11. Agent version remains 2.2.49.

## [2.3.07] - 2026-05-26

### Fixed

- Fixed the upgrade dialog layout overflow and removed detailed command logs from the upgrade modal.
- Fixed Android HTTP panel login by enabling cleartext traffic for Capacitor builds.
- Fixed Android login recovery so a failed panel address no longer causes a white screen on the next launch.
- Fixed SQLite Agent heartbeat errors caused by boolean values being bound directly in raw SQL conditions.

### Changed

- Moved Android panel address configuration into a top-right login setting dialog; captcha, login, and backend requests now use that saved address.
- Bumped panel version to 2.3.07. Agent version remains 2.2.49.

## [2.3.06] - 2026-05-26

### Added

- Added Capacitor-based Android client packaging with GitHub Actions APK builds and release upload.
- Added Android mobile login with saved panel URL, username, password, and mobile token authentication.
- Added Android traffic/package reminder notifications, APK update checks, and unified web/Android app icons.

### Changed

- Android clients now skip the public homepage and enter the backend dashboard after login.
- Switched the project license from MIT to AGPL-3.0-only.
- Bumped panel version to 2.3.06. Agent version remains 2.2.49.

## [2.3.05] - 2026-05-25

### Added

- Added a Telegram settings reminder that Telegram quick login requires a BotFather domain configuration.

### Changed

- Replaced Telegram quick-login widget domain errors on the login page with Chinese guidance before loading the widget.
- Bumped panel version to 2.3.05. Agent version remains 2.2.49.

## [2.3.04] - 2026-05-25

### Fixed

- Fixed panel upgrades failing with "would clobber existing tag" after release tags were rewritten upstream.

### Changed

- Panel install and upgrade scripts now force-sync remote branches and tags before checking out the target version.
- Bumped panel version to 2.3.04. Agent version remains 2.2.49.

## [2.3.03] - 2026-05-25

### Added

- Added a sidebar footer update notice that appears above the account menu when the panel detects a new version.
- Added inline upgrade progress, success, restart, and failure states to the same sidebar notice after an upgrade starts.

### Changed

- Throttled automatic panel update checks to at most once every 10 minutes.
- Bumped panel version to 2.3.03. Agent version remains 2.2.49.

## [2.3.02] - 2026-05-25

### Fixed

- Fixed forwarding group failover and recovery time inputs so values can be cleared and edited without immediately resetting to defaults.
- Added seconds-unit guidance for forwarding group timing fields.

### Changed

- Bumped panel version to 2.3.02. Agent version remains 2.2.49.

## [2.3.01] - 2026-05-25

### Added

- Added forwarding groups as reusable high-availability entries for forwarding rules, including member priority, DDNS failover, recovery switchback, and DDNS event logging.
- Added public registration control so administrators can close self-service registration.

### Changed

- Reorganized README around the new forwarding and tunnel orchestration positioning and added the GitHub Star History chart.
- Bumped panel version to 2.3.01. Agent version remains 2.2.49.

## [2.2.65] - 2026-05-25

### Fixed

- Split panel and Agent version sources so Agent release binaries no longer inherit the panel tag or package version.
- Treat previously misbuilt panel-versioned Agent reports such as 2.2.63/2.2.64 as outdated so they can be upgraded back to the correct Agent version line.

### Changed

- Bumped panel version to 2.2.65 and Agent target version to 2.2.49.

## [2.2.64] - 2026-05-25

### Added

- Added nftables as a forwarding option with panel permissions, rule display, Agent apply/remove commands, and traffic accounting.
- Added footer links for the open-source project and author Telegram support bot for all logged-in users.

### Changed

- Limited GOST in port forwarding to direct port forwarding and removed reverse-tunnel and tunnel selection options from that form.
- Unified empty-state styling for host and tunnel management and removed the regional wording from GOST tunnel configuration.
- Bumped panel version to 2.2.64 and Agent target version to 2.2.48.

## [2.2.63] - 2026-05-24

### Fixed

- Bumped the Agent upgrade target to 2.2.47 so panels can detect and deploy the tunnel protocol blocking Agent update from Agent 2.2.46.

### Changed

- Bumped panel version to 2.2.63. Agent target version is 2.2.47.

## [2.2.62] - 2026-05-24

### Added

- Added per-tunnel HTTP, SOCKS, and TLS protocol blocking for ForwardX and GOST tunnels.
- Added user-facing blocked-rule messages when a tunnel rule is stopped by protocol policy.

### Changed

- Improved the empty tunnel-management state and dark-mode switch visibility.
- Bumped panel version to 2.2.62. Agent version remains 2.2.45.

## [2.2.57] - 2026-05-23

### Added

- Added unified billing ledger views for users and administrators.
- Added Telegram widget login for already bound Telegram accounts.

### Changed

- Improved the billing sidebar labels and settings-page protocol switch management.
- Bumped panel version to 2.2.57. Agent version remains 2.2.45.

## [2.2.56] - 2026-05-22

### Fixed

- Fixed the tunnel creation dialog so it defaults to an enabled tunnel protocol when the ForwardX tunnel protocol is globally disabled.

### Changed

- Bumped panel version to 2.2.56. Agent version remains 2.2.45.

## [2.2.55] - 2026-05-22

### Added

- Added global system switches for all forwarding and tunnel protocols. Disabled protocols are hidden from new selections, existing rules/tunnels stop running without being deleted, and users can only delete unsupported existing entries until an administrator re-enables the protocol.

### Changed

- Bumped panel version to 2.2.55. Agent version remains 2.2.45.

## [2.2.54] - 2026-05-22

### Fixed

- Fixed production startup after v2.2.53 by avoiding a duplicate `fileURLToPath` declaration in the bundled server output.

### Changed

- Bumped panel version to 2.2.54. Agent version remains 2.2.45.

## [2.2.53] - 2026-05-22

### Added

- Added custom public homepage H5/HTML settings with draft preview and saved preview.
- Added a Telegram bot jump button in the bound Telegram dialog.
- Added Telegram admin user renewal with a required confirmation step before extending expiry by one month.
- Added a guided Telegram binding flow for unbound chats, with a 10-minute binding-code session.
- Added announcement content preview with plain text, Markdown, and H5/HTML rendering support.

### Changed

- The sidebar user area now shows a compact account menu entry to avoid duplicated account details.
- Telegram bot menus no longer show the panel-login button, and unbinding now requires confirmation.
- Announcement editing no longer uses shortcut formatting buttons; admins can enter plain text, Markdown, or H5/HTML directly.
- Improved the user-management forward-access column so the switch and status stay readable in narrow browser windows.
- Bumped panel version to 2.2.53. Agent version remains 2.2.45.

## [2.2.52] - 2026-05-22

### Added

- Added paginated Telegram user management for bound administrators, including user detail, traffic reset, and forward-access enable/disable actions.
- Added paginated Telegram rule management for users, including rule detail and enable/disable actions.
- Added Telegram traffic and expiry reminder settings, with scheduled notifications for bound users.
- Added Telegram slash-command registration so users see command suggestions after typing `/` in the bot chat.

### Changed

- Telegram `/rules` and `/users` now open interactive paginated views.
- Bumped panel version to 2.2.52. Agent version remains 2.2.45.

## [2.2.51] - 2026-05-22

### Added

- Added Telegram inline keyboard menus after account binding, with user info, usage, rules, login, admin user overview, and return-to-menu actions.
- Added a clickable bot link in the Telegram binding dialog so users can clearly open the configured bot.

### Changed

- Moved Telegram bot configuration into its own Settings tab before panel logs.
- Improved Telegram binding-code copy fallback for non-secure browser contexts.
- Bumped panel version to 2.2.51. Agent version remains 2.2.45.

## [2.2.50] - 2026-05-22

### Added

- Added Telegram bot test-send support from system settings for the currently bound administrator.
- Added a persistent Telegram bind entry in the sidebar user area.

### Changed

- Moved Telegram bot configuration to a top-level system settings card.
- Replacing the Telegram Bot Token now switches the active bot and resets polling state.
- Bumped panel version to 2.2.50. Agent version remains 2.2.45.

## [2.2.49] - 2026-05-22

### Added

- Added Telegram bot binding, usage lookup, rule management, traffic reset, and one-time panel login support.
- Added project UTF-8 defaults for VSCode, EditorConfig, and Git text normalization.

### Changed

- Bumped panel version to 2.2.49. Agent version remains 2.2.45.

## [2.2.48] - 2026-05-20

### Changed

- Migration codes are now longer, persist while valid, show a countdown, and require old-panel administrator approval before data export starts.
- Bumped panel version to 2.2.48. Agent version remains 2.2.45.

### Fixed

- Fixed SQLite scheduler errors caused by binding Date objects in expiration checks, TCPing cleanup, and subscription traffic recharge queries.
- Replaced the browser-native user traffic reset confirmation with an in-app confirmation dialog.

## [2.2.47] - 2026-05-20

### Added

- Added the first-run setup wizard with database setup, existing-data handling, migration-code import, and administrator setup steps.
- Added public homepage support with login/register entry points and an admin toggle.
- Added dedicated email settings for SMTP, registration verification, expiry reminders, and traffic reminders.
- Added GOST tunnel configuration options for WSS, TLS, TCP, MTLS, MWSS, and MTCP.

### Changed

- Panel migration now uses one-time migration codes, imports data into the new panel, then confirms takeover with the old panel.
- After migration takeover, the old panel pushes Agents to the new panel address and clears business data while retaining administrator accounts.
- Bumped panel version to 2.2.47. Agent version remains 2.2.45.

### Fixed

- Fixed user-management layout overflow on narrow browser windows.
- Fixed sidebar user footer layout so administrator and email labels no longer overlap.

## [2.2.45] - 2026-05-19

### Added

- Open-sourced and added Linux release builds for the ForwardX encrypted tunnel runtime.
- Added random 6-10 character code generation for redemption codes and discount codes.

### Changed

- User balance recharge is now kept in User Management; the balance page focuses on ledgers and marketing codes.
- Redemption and discount creation forms now validate required fields before submitting, avoiding raw API error JSON in the UI.
- Agent release publishing now fails if any required Agent or ForwardX tunnel runtime asset is missing.
- Bumped panel and Agent target versions to 2.2.45.

## [2.2.44] - 2026-05-19

### Changed

- Bumped panel and Agent target versions to 2.2.44.
- Agent now reports ForwardX tunnel startup errors back to the panel logs.
- Release workflow can attach closed ForwardX tunnel runtime assets from CI secrets without committing runtime source.

## [2.2.43] - 2026-05-19

### Added

- Added balance recharge, balance ledger, payment ledger, redemption codes, discount codes, and announcement management.
- Added user dashboard account cards for package, balance, expiry, used traffic, and remaining traffic.

### Changed

- Store purchases now only show enabled payment methods at checkout, and discounts can be scoped to specific plans.
- Bumped panel version to 2.2.43. Agent version remains 2.2.36.

## [2.2.42] - 2026-05-18

### Changed

- Split the large server router, database, and Agent route files into focused modules.
- Added architecture documentation and Agent DTO guards for safer inbound report handling.
- Moved the rules TCPing detail dialog into a dedicated frontend component.
- Bumped panel version to 2.2.42. Agent version remains 2.2.36.

## [2.2.41] - 2026-05-18

### Changed

- Reworked README for a cleaner user-facing release page.
- Bumped panel version to 2.2.41 and Agent version to 2.2.36.
- Prepared this release as the new single public release baseline.

本文件记录 ForwardX 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [2.1.7] - 2026-04-27

### 修复

- **自测状态卡死**：修复了在 Agent 离线、未升级加密版本或网络异常时，转发链路自测任务会一直卡在"执行中"的问题。现在增加了服务端定时扫描机制，超过 60 秒未返回结果的自测任务将自动标记为超时，并在前端提供友好的失败提示

## [2.1.6] - 2026-04-27

### 新增

- **转发方式权限控制**：管理员现在可以在用户管理中为每个普通用户单独指定允许使用的转发方式（iptables / realm / socat），提供更细粒度的资源控制
- **强制加密通讯**：出于安全考虑，面板与 Agent 之间的通讯现已强制要求加密（AES-256-CTR + HMAC-SHA256），不再提供明文降级支持。老用户请重新执行一键安装命令以升级 Agent

### 修复

- **流量监控遗漏**：重构了 Agent 的流量采集逻辑。现在会在下发规则时为三种转发方式统一创建 iptables mangle 计数链，并以此作为主数据源（conntrack 作为备用补充），彻底解决了短连接过期和部分用户态代理导致的流量漏统计问题
- **趋势图空白问题**：修复了当近期流量为 0 或极低时，仪表盘和转发规则页的流量趋势图 Y 轴无刻度导致图表空白的问题，现在提供了最低 1KB 的可视下限

## [2.1.5] - 2026-04-27

### 优化

- **流量趋势图升级**：重构了仪表盘与转发规则页中的流量趋势图，现采用组合图表（柱状图显示瞬时流量 + 曲线显示走势），并支持根据近期流量峰值自适应调整左侧 Y 轴标尺与单位，展示更加直观

## [2.1.4] - 2026-04-27

### 新增

- **面板 Public URL**：支持在系统设置中配置面板公开访问地址（支持反代域名与自定义端口），Agent 安装脚本和回调将优先使用此地址
- **GitHub 官方安装源**：Agent 引导脚本将优先从 GitHub 官方仓库获取完整安装代码，在面板不可达或反代配置异常时提供容错能力
- **入口 IP 自定义**：主机编辑中新增"入口 IP/域名"字段，允许管理员为每个主机配置面向最终用户的入口地址
- **一键复制入口**：在转发规则列表中，新增一键复制"入口IP:端口"的快捷按钮
- **系统信息展示**：在系统设置中新增开源项目 GitHub 地址与 Telegram 官方双向消息机器人链接
- **Agent 通讯加密**：Agent 与面板之间的所有心跳、流量上报等 POST 通讯均启用 AES-256-CTR + HMAC-SHA256 (Encrypt-then-MAC) 加密机制，并加入时间戳防重放攻击

### 修复

- **管理员权限校验**：修复编辑用户主机权限时报错 "No procedure found" 的问题；同时在后端强制限定管理员拥有全部权限且不可被修改
- **用户创建限制**：移除后台创建用户时的"管理员"选项，确保只能创建普通用户；禁止通过修改角色提升普通用户为管理员
- **流量输入优化**：用户流量限额输入框由字符串改为纯数字（GB），输入更直观，留空或 0 表示不限制
- **自动重置优化**：开启月度自动重置时，默认使用当天日期作为重置日
- **主机保存稳健性**：修复在编辑主机时，若清空某些非必填字段（如网卡名称）可能导致意外保存失败的问题
- **UI 优化**：使用 Tabs 标签页重构了用户流量和权限设定弹窗，解决选项过多导致在部分浏览器中无法完整展示的问题

## [2.1.0] - 2026-04-27

### 新增

- **Agent 权限控制**：管理员可为每个用户分配可使用的 Agent 主机，实现资源隔离
- **用户资源限制**：支持限制用户可创建的规则条数和可使用的端口数量
- **移动端适配**：全局响应式布局，完美适配手机端浏览器操作
- **源端口范围校验**：添加规则时，严格校验源端口是否在主机允许的端口区间内

### 变更

- **移除 SSH 支持**：全面转向 Agent 架构，移除所有 SSH 连接相关的代码和 UI，简化系统复杂度
- **连通性检测简化**：移除本地端口监听检测，仅保留目标端口 TCP 可达性和 tcping 延迟检测，提高检测速度和准确性

## [2.0.0] - 2026-04-27

### 新增

- **用户流量管理**：支持设置用户流量额度（GB/TB），超额自动禁用规则
- **到期时间控制**：支持设置用户到期时间，到期后自动禁用规则
- **流量自动重置**：支持设置每月指定日期自动清零已用流量
- **开放注册**：登录页新增注册功能，支持简单的算术验证码
- **细粒度权限控制**：管理员可单独控制用户是否允许添加新规则
- **主机端口区间限制**：管理员可设置主机允许转发的端口区间（如 10000-20000）
- **源端口智能分配**：添加规则时自动检测端口占用，默认随机分配可用端口
- **安全增强**：登录失败后强制要求验证码，防暴力破解；Cookie 有效期延长至 10 天
- **仪表盘升级**：新增全局流量走势图和用户流量使用汇总排行
- **主机删除保护**：当主机下存在转发规则时，禁止删除主机并提示用户先删除规则

### 移除

- **移除单规则限速功能**：去除了基于 tc 的上传/下载限速功能，改为基于用户的全局流量额度管理

## [1.0.0] - 2025-04-25

### 新增

- 多引擎端口转发：支持 iptables、realm、socat 三种转发工具
- 多主机 Agent 管理：一键安装脚本、systemd 服务、心跳上报
- 转发规则管理：创建/编辑/启停/删除，支持 TCP/UDP/Both 协议
- 流量统计：基于 iptables 计数链的精确流量采集，支持趋势图表
- 带宽限速：基于 tc 的每规则独立上传/下载限速
- 连通性检测：目标可达性检测 + ping 延迟测量
- 多用户权限：管理员/普通用户角色分离，资源隔离
- 主机监控：CPU、内存、网络、磁盘使用率实时上报
- 配置导入导出：JSON 格式的规则和主机配置备份与恢复
- Docker 一键部署：多阶段构建，内置 SQLite
- 暗色主题：亮色/暗色主题切换，跟随系统偏好
