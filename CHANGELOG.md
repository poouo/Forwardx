# Changelog

## [2.3.183] - 2026-06-25

### 新增与优化

- Telegram WebApp 接入增强：
  - 机器人菜单与命令支持 `/webapp`，可在 Telegram 内直接拉起面板。
  - WebApp 自动登录链路加入 `initData` 验签、防重放与一次性挑战令牌校验，避免被非 Telegram 场景滥用。
  - 修复重复使用旧入口导致“登录入口失效”的稳定性问题，提升二次打开成功率。
- Telegram 管理指令增强：
  - 新增 `/updatepanel` 与 `/updateagent`（仅命令可见，不进主菜单），执行前确认，并增加与 Web 端一致的短时限流。
  - 管理写操作统一“先确认再执行”，降低误操作风险。
- AI 管理意图增强（DeepSeek）：
  - 增强模糊写操作识别与二次追问（60 秒内补全），例如“给我充点钱”会继续询问金额后再确认执行。
  - 新增折扣码与余额兑换码生成能力，支持自然语言数量/金额/折扣解析与补问，生成结果回传 Telegram 并可在后台管理。
  - 新增普通用户 AI 管理开关：关闭后仅管理员可执行 AI 管理写操作（查询不受影响）。
- 转发规则 AI 管理增强：
  - 支持自然语言新增/删除转发规则。
  - 当未明确“端口转发/隧道转发”时，弹出选择；隧道模式可继续选择具体隧道；主机模式可选择主机。
  - 未指定源端口时支持随机端口并进入确认流程后执行。
  - 支持按规则号与条件筛选删除，多条命中时先展示候选规则供确认。
- Telegram 机器人信息自动撤回：
  - 新增 AI 相关聊天内容自动撤回开关（默认关闭）。
  - 撤回时间可配置为 30-1200 秒，默认 60 秒。
- AI 聚合平台支持（SiliconFlow 等 OpenAI 兼容接口）：
  - 后台可选择 AI 提供方、Base URL 与模型。
  - 支持从 API 拉取模型列表并展示 `free/paid/unknown` 状态，便于优先选择免费模型。
- 端口转发链路探测 UI 优化：
  - 多入口链路目标节点优先展示落地备注名，不再优先展示 IP。
  - 修复多入口首块居中与小屏显示不全问题，提升整体可读性。

- 转发规则与隧道展示优化：
  - 转发规则中的隧道入口展示优先使用入口组域名或成员 DDNS，减少直接展示入口 IP 的情况。
  - 隧道管理列表不再额外展示入口 IP 信息，避免多入口场景下内容过载。
  - 入口机链路探测过滤自身到自身的无效线段，修复多入口延迟绘制与外层延迟不一致的问题。
- 限速与运行时刷新修复：
  - 用户 GOST 限速、最大连接数、最大 IP 数调整后会自动刷新相关端点并重置运行状态，避免配置已保存但旧进程仍使用旧限速。
  - FXP 隧道运行时改为 TCP/UDP 共用入口限速器，并在启动日志中输出 limitIn/limitOut，便于排查限速是否生效。
- Telegram 机器人体验优化：
  - 转发规则按钮优先展示备注名/规则名，降低仅显示规则 ID 时的识别成本。
  - AI 查询规则结果增加结构化排版、流量详情和用户模糊筛选能力。
  - 管理员可通过自然语言开启或关闭开放注册，执行前仍保留确认流程。

### 版本说明

- 面板版本升级至 `2.3.183`，Agent 目标版本保持 `2.2.114`。
- Android APP 版本升级至 `2.3.55`，APK 发布指向更新至 `2.3.183`，方便安卓用户检测到包含最新 UI 的更新。

## [2.3.181] - 2026-06-25

### Fixed and Improved

- Added the post-2.3.180 Telegram AI query updates to this release: DeepSeek settings, read-only natural-language panel queries, permission-scoped results, finer filters for users/hosts/rules/tunnels/groups, and Telegram HTML-formatted replies.
- Included the post-2.3.180 tunnel latency updates: multi-entry tunnel probing now keeps the outside latency display aligned with the detailed route probe results.
- Fixed forwarding-rule entry address display so single-port forwarding prefers the host DDNS domain when available, keeps the manually configured entry address visible, and falls back to the automatically detected IP only when neither exists.
- Fixed forwarding-chain entry display when an entry group is attached but has no group domain: it now falls back to the entry-group member DDNS first, then the member entry address, then the detected IP/IPv6 address.
- Fixed tunnel entry display for single-member entry groups so the group domain or member DDNS is still preferred instead of falling back directly to the host IP.

### Versions

- Bumped panel version to 2.3.181. Agent target version remains 2.2.114.
- Bumped Android APP version to 2.3.54 and updated the APK release pointer to 2.3.181 so Android users can receive the latest UI changes.

## [2.3.180] - 2026-06-24

### 修复与优化

- 优化转发链多入口规则卡片的入口地址展示，使用入口组 DDNS 域名时不再额外展开各入口主机的 IPv4/IPv6 地址。
- 优化转发规则标准/精简卡片首次加载和刷新时的入场动画，避免流量/延迟数据补齐后出现卡片抽动。
- 修复普通 IPv4 端口转发规则在入口主机同时上报 IPv6 地址时，错误显示“跨 IPv4/IPv6 风险”的误报。
- 优化多入口转发链自测图，入口节点内按行展示各入口延迟/失败状态，后续链路保持单条公共线路，并兼容三入口及以上和手机端展示。
- 修复主机管理、链路管理顶部标签刷新后回到第一个标签的问题，现在会记住用户当前所在标签。
- 转发规则列表新增统一搜索框，可按端口、入口/目标 IP 或域名、备注、主机、用户、隧道和链路名称快速筛选。
- 修复端口转发链规则外层卡片/表格延迟直接取入口到落地 TCPing 的问题，现在优先展示最近一次链路自测的总延迟，与自测弹窗保持一致。
- 更新 README 中的版本、下载链接与当前转发链、DDNS、自测和风险提示说明。

### 版本

- 面板版本升级至 2.3.180，Agent 目标版本保持 2.2.114。
- Android APP 版本升级至 2.3.53，APK 发布指向更新至 2.3.180，方便安卓用户检测到包含最新 UI 的更新。

## [2.3.179] - 2026-06-24

### 修复与优化

- 修复端口转发链多入口自测链路图把多个入口错误串联展示的问题，改为合并入口节点并同时展示各入口延迟。
- 修复端口转发链已被规则引用时仍显示“等待转发规则引用”的状态文案。
- 优化入口组、出口组和转发链成员状态展示，避免多入口场景只高亮单个成员。
- 规则自测等待态同步展示入口组中的多个入口主机。
- 优化转发规则入口地址展示优先级，优先使用手动入口地址，其次使用 DDNS 域名，最后回退自动检测 IP，并保留 IPv6 入口展示。
- 增加 iptables/nftables 跨 IPv4/IPv6 转发风险提示，减少内核转发与用户态转发场景混淆。
- 修复 UDP 转发链自测中间跳使用 ping 导致实际转发不通但自测通过的误判问题。

### 版本

- 面板版本升级至 2.3.179，Agent 目标版本保持 2.2.114。
- Android APP 版本升级至 2.3.52，APK 发布指向更新至 2.3.179，方便安卓用户检测到包含最新 UI 的更新。

## [2.3.178] - 2026-06-24

### 新增

- 转发规则卡片中，端口转发链会同时展示当前规则使用的转发工具，例如 iptables、nftables、realm、socat 或 gost。

### 修复与优化

- Agent IPv6 上报增加本机全局 IPv6 自动检测，覆盖 IPv6 仅作为入口地址、无法通过公网出口检测接口识别的场景。
- Agent 读取本机 IPv6 时优先使用非 tentative/dadfailed、非 deprecated 的全局地址，减少误报不可用入口地址。

### 版本

- 面板版本升级至 2.3.178，Agent 目标版本升级至 2.2.114。
- Android APK 发布指向更新至 2.3.178，方便安卓用户检测到包含最新 UI 的更新。

## [2.3.177] - 2026-06-24

### 新增

- 左侧“隧道管理”调整为“链路管理”，并将原独立“转发组”入口迁入链路管理页。
- 链路管理内按“隧道链路 / 端口转发链 / 转发组 / 入口组 / 出口组”统一管理相关链路资源。
- 添加转发规则时拆分为“端口转发 / 隧道转发 / 转发链 / 转发组”四种入口，转发链和转发组不再共用同一个选择项。

### 修复与优化

- 修复转发规则绑定端口转发链时，编辑和新增弹窗可能按转发组展示或校验的问题。
- 修复链路自测在端口转发链 IPv6 出口到目标场景下，最终目标探测可能使用错误地址导致误判失败的问题。
- 修复延迟图表开启削峰后，曲线在低延迟位置可能越出图表边界的问题。
- 优化链路、转发链和出口组中 IPv6/内网/指定地址的展示标识，减少入口出口信息混淆。

### 版本

- 面板版本升级至 2.3.177，Agent 目标版本保持 2.2.113。
- Android APP 版本升级至 2.3.51，APK 发布指向更新至 2.3.177，方便安卓用户检测到包含最新 UI 的更新。

## [2.3.176] - 2026-06-24

### 新增

- 隧道链路和端口转发链新增 IPv6 转发开关，位置与内网 IP 开关并列；默认关闭并继续优先使用 IPv4/默认入口地址。
- IPv6 转发开关仅在对应主机存在 IPv6 地址时可开启，不存在 IPv6 的主机会禁用开关并提示原因。
- 转发规则入口地址展示支持同时列出 IPv4 与 IPv6 入口，存在 IPv6 时可直接复制 IPv6 入口地址。

### 修复与优化

- 修复 GOST 隧道和端口转发链使用 IPv6 地址时，运行配置中可能出现未加方括号的 `IPv6:端口` 地址，导致拨号解析不正确的问题。
- 后端保存链路和出口组连接地址时校验 IPv6 必须来自对应主机，避免绕过前端保存无效地址。
- 保留转发链、隧道和额外出口的默认 IPv4 行为，只有用户显式打开 IPv6 转发时才按 IPv6 下发连接地址。
- 优化 Agent 动作下发批次复用和部分运行配置日志输出，减少规则较多时的重复动作与无效日志压力。

### 版本

- 面板版本升级至 2.3.176，Agent 目标版本升级至 2.2.113。
- Android APP 版本升级至 2.3.50，APK 发布指向更新至 2.3.176，方便安卓用户检测到包含最新 UI 的更新。

## [2.3.175] - 2026-06-24

### 修复与优化

- 修复部分系统 nftables 在 IPv6 端口转发中无法创建 forward 放行规则，导致规则实际可转发但面板状态一直显示黄色的问题。
- 调整 nftables forward 规则下发顺序与注释格式，避免部分 nft 版本对 `accept` 后置注释或特殊字符注释兼容不佳。
- 增加 nftables forward 规则多级回退：计数规则失败时回退普通注释规则，仍失败时回退无注释放行规则，优先保证转发规则运行状态正确。
- Agent 统计兼容新的 nftables 规则标记格式，同时保留对旧标记格式的识别。

### 版本

- 面板版本升级至 2.3.175，Agent 目标版本升级至 2.2.112。
- Android APP 版本保持 2.3.49，APK 发布指向更新至 2.3.175。

## [2.3.174] - 2026-06-24

### 新增

- 主机编辑新增排序配置，支持填写 0-200 的排序值；主机列表按排序值优先展示，相同排序值由系统自动排列。
- 转发规则新增 TCP Fast Open 和 zero-copy 配置能力，端口转发在支持的后端中可按规则开启，不支持的场景会自动禁用或清理配置。
- 隧道转发的 PROXY Protocol 配置按入口和出口分别下发，方便 GOST/ForwardX 隧道按链路角色传递真实来源地址。

### 修复与优化

- 修复首页累计流量、出入站流量在新统计链路下可能长时间不刷新的问题，累计统计改为直接读取原始流量数据，避免聚合桶滞后影响展示。
- 优化首页和转发规则流量汇总缓存与轮询间隔，使近 24 小时与累计统计在规则较多时也能更及时更新。
- 优化 GOST/ForwardX 隧道 PROXY Protocol、TCP Fast Open 配置下发和日志信息，便于排查来源 IP 传递问题。
- 补充上一版未记录的主机排序、转发规则传输优化和 Agent/FXP 支持内容。

### 版本

- 面板版本升级至 2.3.174，Agent 目标版本发布为 2.2.111。
- Android APP 版本升级至 2.3.49，APK 发布指向更新至 2.3.174，方便安卓用户检测并安装包含最新 UI 的 APK。

## [2.3.173] - 2026-06-24

### 修复与优化
- 修复 IPv6 端口转发切换目标后可能残留旧 ip6tables/nftables DNAT 规则，导致请求仍命中旧目标或新目标不通的问题。
- 优化 Agent 下发 iptables、ip6tables、nftables 内核转发规则前的端口清理逻辑，避免同端口旧规则影响新的转发链路。
- 修复 nftables 转发流量统计在计数为 0 时可能错误回退到 iptables 统计源的问题，提高非 GOST 转发链路的流量统计准确性。
- 优化链路自测和服务延迟图表在手机端、安卓端的展示密度，统计信息更紧凑，弹窗内容不易被截断。
- 延迟图表改为曲线绘制并使用更细的连线，只优化视觉表现，不改变实际采样数据和统计值。

### 版本
- 面板版本升级至 2.3.173，Agent 目标版本升级至 2.2.110。
- Android APP 版本保持 2.3.48，APK 发布指向更新至 2.3.173。

## [2.3.172] - 2026-06-24

### Fixed
- Fixed firewall command generation for iptables, ip6tables, and nftables so forwarding rules no longer depend on fallback shell operators that can be mangled in some Agent environments.
- Fixed missing IPv6 firewall forwarding rules and related traffic counters for port forwarding, forward chains, and tunnel paths.
- Moved nftables forwarding traffic counters into the traffic_forward chain so accepted IPv4 and IPv6 packets are counted before later accept rules can bypass counters.
- Updated Agent-side traffic counter repair commands and access-limit chain commands to use the same safer shell form.
- Included host service view-switch placement and card/list transition refinements from the current working tree.

### Versions
- Bumped panel version to 2.3.172 and Agent target version to 2.2.109.
- Android APP version remains 2.3.48 and the APK release pointer is updated to 2.3.172.

## [2.3.171] - 2026-06-23

### 修复与优化
- 修复转发链目标为域名时，防火墙转发下发仍可能使用域名导致 iptables/nftables 规则失败的问题；数据库继续保留域名，运行时按当前解析 IP 下发，并在域名变更后自动刷新规则。
- 修复 MySQL 下 Agent 重连重置隧道运行态时因 UPDATE tunnels 自查询触发的报错。
- 修复 GOST 隧道多出口映射在并发心跳下可能重复插入导致 heartbeat 失败的问题。
- 优化 nftables 转发流量统计，直接在实际 IPv4/IPv6 forward 规则上计数，避免额外统计链规则失败导致 IPv6 转发状态异常。
- 修复 IPv4 iptables 统计规则失败可能影响规则下发的问题，Agent 会记录统计规则修复失败和“有连接但计数未命中”的限流诊断日志。
- Agent 升级到 2.2.108 后会自动刷新关联运行态，确保旧 iptables/nftables 规则重下发并带上新的计数规则。
- 增强 Agent 端 GOST 隧道 PROXY Protocol 摘要日志，显示出口服务的 accept/send 开关和目标地址，便于排查源 IP 传递问题。

### 版本
- 面板版本升级至 2.3.171，Agent 目标版本升级至 2.2.108。
- Android APP 版本保持 2.3.48，APK 发布指向更新至 2.3.171。

## [2.3.170] - 2026-06-23

### 修复与优化

- 修复多入口组在隧道和端口转发链中只下发单入口或链路不通的问题，入口组成员会作为固定入口统一刷新和监听。
- 修复多链路转发 IPv4 流量未归集到模板规则的问题，并同步覆盖链路/隧道的入口组统计路径。
- 增加 Agent 侧 IPv6 转发与流量计数诊断日志，便于排查非 GOST 转发 IPv6 不通和已通链路未统计流量的问题。
- 统一新增规则、链路和隧道类型切换控件的选中样式，提高当前选项辨识度。

### 版本

- 面板版本升级至 2.3.170，Agent 目标版本升级至 2.2.107。
- Android APP 版本保持 2.3.48，APK 发布指向更新至 2.3.170。

## [2.3.169] - 2026-06-23

### 修复与优化

- 修复端口转发链使用入口组时的链路角色、入口展示和自测路径，避免入口、出口与中转节点展示混淆。
- 优化转发组与端口转发链的入口组校验逻辑，入口组已提供入口时，链路内首个节点不再被错误要求配置入口地址。
- 调整 GOST 隧道 PROXY Protocol 出口转发下发方式，使入口和出口开关能按隧道转发链路正确传递。
- 优化新增链路、隧道类型等选择控件的选中状态，让当前选项更清晰。
- 优化弹窗定位和入场动画，减少部分 Windows 设备上弹窗字体发虚、模糊和底层布局抖动的问题。

### 版本

- 面板版本升级至 2.3.169，Agent 目标版本保持 2.2.106。
- Android APP 版本保持 2.3.48，APK 发布指向更新至 2.3.169。

## [2.3.168] - 2026-06-23

### 新增

- 主机套餐流量计算新增“取最大值”模式，可按入站/出站累计流量中的较大值计算已用流量。
- 延迟图表新增“削峰”显示开关，可在转发规则、转发链、隧道和主机服务延迟图表中降低突发尖峰对视觉曲线的影响。
- GitHub Release 发布页会展示当前版本中文升级说明，方便在资产下载区域直接查看本次改进内容。

### 修复与优化

- 优化周期性 Ping 探测的采样方式，降低单次抖动对服务延迟图表的影响；链路自测仍保持单次探测，避免测试耗时变长。
- 优化服务延迟图表筛选体验，切换单项/多项服务时不再反复触发图表入场动画。
- 细化延迟图表线条和纵轴范围，减少多条曲线重叠时的视觉干扰，并按最高延迟动态扩展显示范围。
- 修复主机流量耗尽提醒在新计算模式下的已用流量和计算方式展示。

### 版本

- 面板版本升级至 2.3.168，Agent 目标版本升级至 2.2.106。
- Android APP 版本保持 2.3.48，APK 发布指向更新至 2.3.168。

## [2.3.167] - 2026-06-23

### Added

- Added an upgrade changelog shortcut in system settings so admins can open the GitHub changelog from the update area.
- Added service filtering and a clear action to the host service latency chart, allowing single-service or multi-service latency views.

### Fixed

- Fixed Agent control-plane recovery when the panel public URL changes: heartbeat responses now publish the current panel URL, online Agents persist it locally, and Agent requests immediately switch to the updated URL.
- Fixed Agent upgrade recovery so re-running the upgrade script with a new `PANEL_URL` rewrites `/etc/forwardx-agent/config.json` and restores communication without reinstalling.
- Fixed dropdown, select, tooltip, and dialog overlays so popup UI no longer causes underlying page scrollbar jitter or layout flashing.
- Improved host edit dialog scrolling and reduced modal animation overhead on slower clients.
- Improved collapsed sidebar hover visuals so the logo/icon enlargement remains crisp.

### Changed

- Bumped panel version to 2.3.167 and Agent target version to 2.2.105.
- Android APP version remains 2.3.48 and the APK release pointer is updated to 2.3.167.

## [2.3.165] - 2026-06-23

### Fixed

- Fixed DDNS settings save failing silently after the TTL field was added.
- Fixed DDNS provider dropdowns causing the page scrollbar to disappear and the settings layout to jump.
- Fixed port-forwarding chains with entry groups so creating a chain no longer raises `entryGroupId is not defined`, and entry groups can be used as fixed chain entries.
- Fixed entry groups so DDNS provider configuration is required only when automatic resolution is enabled; manual-domain mode now saves without a system DDNS provider.
- Fixed user-space IPv6 forwarding for realm and socat listeners and restored traffic accounting for ForwardX/GOST-backed user-space forwarding, including IPv6 counters.
- Localized forwarding-group DDNS and health-check status messages that were still shown in English.

### Changed

- Entry and exit group dialogs now keep only group name plus enable state, keep record type visible for entry groups, and clarify that empty domestic health-check targets default to `www.189.cn:80`.
- Bumped panel version to 2.3.165 and Agent target version to 2.2.104.
- Android APP version remains 2.3.48 and the APK release pointer is updated to 2.3.165.

## [2.3.164] - 2026-06-23

### Added

- Added entry and exit forwarding groups with card/list management, remarks, entry DDNS binding, and group selection in tunnel and forwarding-chain workflows.
- Added DDNS TTL configuration and entry-group health checks that can temporarily remove unhealthy entries from shared DDNS records.

### Fixed

- Fixed IPv6 traffic accounting for iptables-backed forwarding by installing and reading ip6tables counting rules alongside IPv4 rules.
- Fixed nftables forwarding and counters to use dual-stack rule matching and IPv6 NAT targets when the destination is IPv6.
- Extended Agent cleanup, access-limit, dependency, and forwarding setup paths to cover ip6tables/nftables and IPv6 forwarding.

### Changed

- Multi-entry groups can be used only as entries and multi-exit groups only as exits; tunnel multi-exit selection now uses saved exit groups instead of ad-hoc multi-exit toggles.
- Bumped panel version to 2.3.164 and Agent target version to 2.2.103.
- Android APP version remains 2.3.48 and the APK release pointer is updated to 2.3.164.

## [2.3.163] - 2026-06-22

### Fixed

- Cleared stale tunnel runtime readiness caches when Agents reconnect, host runtime settings change, DNS updates are reported, or tunnel endpoints are refreshed so custom ForwardX tunnels are reapplied after Agent upgrades without requiring a manual toggle.
- Included load-balance tunnel exit nodes when waking affected Agents for runtime refreshes.
- Refined host edit date inputs, traffic quota display, and host-card realtime traffic labels.

### Changed

- Added a host traffic exhaustion reminder hint clarifying that alerts are sent through the TG bot.
- Bumped panel version to 2.3.163. Agent target version remains 2.2.102.
- Android APP version remains 2.3.48 and the APK release pointer is updated to 2.3.163.

## [2.3.162] - 2026-06-21

### Added

- Added host-level DDNS controls so a host can update IPv4 or IPv6 records through the configured system DDNS provider when the Agent-reported address changes.
- Added panel-hosted ForwardX runtime and GOST release assets as a fallback path for Agent install and upgrade when GitHub assets are unavailable.

### Fixed

- Reworked Agent install and upgrade downloads to use connection timeout plus low-speed timeout instead of a fixed total download timeout, preventing slow active downloads from being interrupted.
- Applied the same low-speed timeout handling to GOST and realm runtime asset downloads and copied install commands.

### Changed

- Host cards now show traffic quota usage in the resource section and avoid duplicating the old inbound/outbound total cards.
- Bumped panel version to 2.3.162 and Agent target version to 2.2.102.
- Android APP version remains 2.3.48 and the APK release pointer is updated to 2.3.162.

## [2.3.161] - 2026-06-21

### Fixed

- Fixed GOST tunnel business routing so the primary and load-balance exits use the configured tunnel exit listener ports for the primary active rule instead of unexpected rule-allocated ports.
- Avoided generating duplicate GOST probe listeners on tunnel exit ports that are already used by active business tunnel rules.

### Changed

- Bumped panel version to 2.3.161. Agent target version remains 2.2.101.
- Android APP version remains 2.3.48 and the APK release pointer is updated to 2.3.161.

## [2.3.160] - 2026-06-21

### Fixed

- Reworked Agent install script runtime checks so existing /usr/local/bin/forwardx-runtime is reused only when the bundled GOST runtime version matches; otherwise GOST is reinstalled and install/upgrade stops on runtime failure.
- Fixed load-balanced GOST/ForwardX tunnel TCPing history by storing each exit as its own latency series plus an aggregate maximum-latency series.
- Fixed tunnel latency charts so load-balanced tunnels show primary and extra exits with distinct colors and per-exit timeout states.

### Changed

- Agent now preserves tunnel probe series metadata in TCPing reports and sends all current tunnel probes together so multi-exit history is not split across cycles.
- Bumped panel version to 2.3.160 and Agent target version to 2.2.101.
- Bumped Android APP version to 2.3.48 and updated the APK release pointer to 2.3.160.

## [2.3.159] - 2026-06-21

### Added

- Added optional mainland China health checks for failover forwarding groups, with custom tcping targets and member-level result tracking.
- Added remaining-time badges on host cards when both purchase and stop dates are configured.

### Changed

- Improved host management card and list address display so IPv6 is hidden outside the host edit Agent detection field.
- Increased live host traffic refresh while the host management tab is active and reduced refresh pressure when it is not visible.
- Refined forwarding-rule traffic layout, import/export dialogs, host edit density, date picker visuals, and modal backdrop motion.
- Bumped panel version to 2.3.159 and Agent target version to 2.2.100.
- Bumped Android APP version to 2.3.47 and updated the APK release pointer to 2.3.159.

## [2.3.157] - 2026-06-20

### Added

- Added forwarding-rule import and export dialogs for host, tunnel, forwarding-chain, and forwarding-group scoped rule files, with type matching validation before import.
- Added package traffic limits in GB, traffic direction mode selection, and Telegram traffic-threshold alert controls to host editing.

### Changed

- Renamed host traffic configuration to other configuration and moved port limits and protocol blocking into basic host information.
- Forwarding rule traffic columns now show total link traffic before the 24-hour traffic and latency details.
- Improved shared dialog overlay timing, blur strength, and panel motion for smoother modal transitions.
- Bumped panel version to 2.3.157. Agent target version remains 2.2.99.
- Bumped Android APP version to 2.3.45 and updated the APK release pointer to 2.3.157.

## [2.3.156] - 2026-06-20

### Changed

- Improved host and tunnel management selectors with compact selected-host rows, status labels, and clearer load-balance exit controls.
- Reworked the host edit dialog into focused tabs and refined dialog motion handling so card animations do not conflict with modal transitions.
- Bumped panel version to 2.3.156. Agent target version remains 2.2.99.
- Android APP version remains 2.3.44 and the APK release pointer is updated to 2.3.156.

## [2.3.141] - 2026-06-15

### Fixed

- Fixed PROXY Protocol availability when adding forwarding rules, so port forwarding and host forward groups can enable it without first switching through tunnel forwarding.

### Changed

- Bumped panel version to 2.3.141. Agent target version remains 2.2.92.
- Updated the Android APK release pointer to 2.3.141.

## [2.3.140] - 2026-06-15

### Added

- Added card/list layout switching for subscription plans and traffic-billing resources, defaulting to card view with animated transitions.
- Added the subscription records tab to Billing & Redemption so plan subscriptions are managed with billing and redemption records.

### Fixed

- Fixed the garbled `package.json` description text.

### Changed

- Moved subscription records out of Plan Management.
- Improved host compact-card metric alignment and tooltips for CPU, memory, and disk usage.
- Tightened the forwarding-rule add/edit dialog width and field density.
- Reduced repeated backup-summary polling and optimized panel migration data-summary checks.
- Bumped panel version to 2.3.140. Agent target version remains 2.2.92.
- Bumped Android APP version to 2.3.44 and updated the APK release pointer to 2.3.140.

## [2.3.139] - 2026-06-14

### Added

- Added a compact host card layout for host management, with lighter CPU, memory, disk, and traffic display.

### Fixed

- Fixed forwarding-rule active counts so empty filtered views no longer show totals from other categories.
- Fixed the host table status column wrapping issue.

### Changed

- Tightened the forwarding-rule add/edit dialog layout and reduced non-essential helper text.
- Clarified panel SSL certificate source selection between file paths and pasted PEM certificates.
- Bumped panel version to 2.3.139. Agent target version remains 2.2.92.
- Bumped Android APP version to 2.3.43 and updated the APK release pointer to 2.3.139.

## [2.3.138] - 2026-06-14

### Added

- Added host port policy support for combined port ranges and comma-separated custom allowed ports, with panel-side validation for invalid custom port input.
- Added transition animations when switching rule card density, tunnel views, forwarding-chain views, and forwarding-group empty/list states.

### Fixed

- Fixed multi-hop tunnel, forwarding-chain, and TCPing latency charts when 24-hour samples exceed the display cap; the chart now keeps the newest samples instead of truncating at the oldest 2880 records.
- Reduced stale caching for latency detail dialogs and avoided showing obviously old cached latency series while fresh data is loading.
- Existing forwarding rules, tunnels, forwarding groups, Telegram actions, and scheduled refresh paths now re-check host port policies so edited host limits are enforced consistently.
- Agent upgrade actions now skip hosts that already report the latest target version instead of pushing a redundant upgrade event.
- Multi-hop tunnel runtime sync now wakes pending hop Agents faster and asks Agents to refresh tunnel latency immediately after tunnel services report running.
- Panel SSL settings now use a full-width layout with file-path inputs and PEM paste fields arranged side by side.

### Changed

- Dashboard recent traffic trend now shows the last 24 hours with hourly totals, and the traffic doughnut charts use the same 24-hour window.
- Host cards now present upload/download traffic as clearer colored tiles and color CPU, memory, and disk usage by utilization thresholds.
- PROXY Protocol can now remain enabled for TCP+UDP rules while still being disabled for UDP-only rules.
- Bumped panel version to 2.3.138. Agent target version is now 2.2.92.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.138.

## [2.3.137] - 2026-06-14

### Added

- Added host port policy support for combined port ranges and comma-separated custom allowed ports, with panel-side validation for invalid custom port input.
- Added transition animations when switching rule card density, tunnel views, forwarding-chain views, and forwarding-group empty/list states.

### Fixed

- Fixed multi-hop tunnel, forwarding-chain, and TCPing latency charts when 24-hour samples exceed the display cap; the chart now keeps the newest samples instead of truncating at the oldest 2880 records.
- Reduced stale caching for latency detail dialogs and avoided showing obviously old cached latency series while fresh data is loading.
- Existing forwarding rules, tunnels, forwarding groups, Telegram actions, and scheduled refresh paths now re-check host port policies so edited host limits are enforced consistently.
- Agent upgrade actions now skip hosts that already report the latest target version instead of pushing a redundant upgrade event.

### Changed

- Dashboard recent traffic trend now shows the last 24 hours with hourly totals, and the traffic doughnut charts use the same 24-hour window.
- Host cards now present upload/download traffic as clearer colored tiles and color CPU, memory, and disk usage by utilization thresholds.
- PROXY Protocol can now remain enabled for TCP+UDP rules while still being disabled for UDP-only rules.
- Bumped panel version to 2.3.137. Agent target version remains 2.2.91.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.137.

## [2.3.136] - 2026-06-13

### Added

- Added panel HTTPS/SSL configuration support and runtime status handling.
- Added Agent/FXP runtime updates for the 2.2.91 target line.
- Added PROXY Protocol support improvements for GOST and ForwardX encrypted tunnel paths.

### Fixed

- Improved panel update checks, Docker/runtime version reporting, and release asset readiness checks.
- Improved forwarding-rule handling around PROXY Protocol and tunnel routes.

### Changed

- Bumped panel version to 2.3.136 and Agent target version to 2.2.91.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.136.

## [2.3.135] - 2026-06-13

### Fixed

- Adjusted the add-link dialog layout so tunnel and forwarding-chain creation forms scroll and size more predictably across viewports.

### Changed

- Bumped panel version to 2.3.135. Agent target version remains 2.2.90.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.135.

## [2.3.134] - 2026-06-13

### Added

- Added reusable host status labels and clearer online/offline indicators in link creation flows.
- Added link creation selector and setup flow refinements for tunnel and forwarding-chain creation.

### Fixed

- Improved multi-hop tunnel editor layout and tunnel list presentation.
- Improved dashboard traffic breakdown handling and setup-page database guidance.

### Changed

- Bumped panel version to 2.3.134. Agent target version remains 2.2.90.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.134.

## [2.3.133] - 2026-06-13

### Fixed

- Added animated loading placeholders for home traffic doughnut charts so the chart, ranking rows, and legend keep a stable shape while traffic data loads.
- Fixed home traffic doughnut ranking rows so long names, traffic values, and percentages no longer overlap in narrow cards.
- Added online/offline status dots to host choices in forwarding-rule filters, local forwarding host selection, and rule copy host lists.

### Changed

- Bumped panel version to 2.3.133. Agent target version remains 2.2.90.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.133.

## [2.3.132] - 2026-06-13

### Added

- Added production-oriented MySQL/PostgreSQL connection pool defaults for roughly 30 Agent hosts, plus environment variables and README guidance for tuning pool size, idle connections, lifetime, idle timeout, and connect timeout.

### Fixed

- Unified host editing into a single form view instead of splitting basic info, port limits, and protocol controls into separate inner sections.
- Host protocol blocking is now managed only from Host Management; forwarding rules and tunnels ignore legacy per-rule/per-tunnel HTTP/SOCKS/TLS block fields.
- Host protocol and address policy changes now refresh existing direct, tunnel, forwarding-group, and forwarding-chain runtimes so already-created entries follow the updated host policy.
- Host port range changes now pause existing direct rules on that entry host when their source port is outside the new range; users must edit to an allowed port before enabling again.
- Rule enabling from the panel and Telegram now rechecks the current host or tunnel entry port policy before clearing a policy block.
- Home traffic doughnut charts now use the cleaner reference-style ring layout with center totals, ranked detail rows, and a one-time initial animation so frequent refreshes no longer replay the chart animation.

### Changed

- Bumped panel version to 2.3.132. Agent target version remains 2.2.90.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.132.

## [2.3.131] - 2026-06-12

### Fixed

- Optimized dashboard, metrics, forwarding-rule, tunnel, and forwarding-group queries for MySQL/PostgreSQL by adding summary-oriented reads, cache helpers, and database maintenance coverage.
- Moved HTTP/SOCKS/TLS protocol blocking toward host-side policy enforcement and refreshed affected Agent runtime state when policies change.
- Improved host, tunnel, rule, and forwarding-group loading behavior under frequent refreshes.

### Changed

- Bumped panel version to 2.3.131. Agent target version remains 2.2.90.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.131.

## [2.3.130] - 2026-06-12

### Fixed

- Fixed the dashboard recent traffic trend on PostgreSQL after migration by using database-compatible aggregation and timestamp handling.

### Changed

- Bumped panel version to 2.3.130. Agent target version remains 2.2.90.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.130.

## [2.3.129] - 2026-06-12

### Added

- Added PostgreSQL migration health checks that run once per marker, report checked/created indexes, analyzed tables, and largest traffic/metrics tables in panel logs.

### Fixed

- Improved PostgreSQL setup and migration handling so database initialization can backfill indexes and table statistics after migration without repeating every startup.

### Changed

- Bumped panel version to 2.3.129. Agent target version remains 2.2.90.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.129.

## [2.3.128] - 2026-06-12

### Fixed

- Removed global loading screens that caused the panel to blank during background refreshes.
- Improved dashboard traffic summaries and homepage loading states so cached data remains visible while refreshes are in progress.

### Changed

- Bumped panel version to 2.3.128. Agent target version remains 2.2.90.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.128.

## [2.3.127] - 2026-06-12

### Fixed

- Hardened repository boolean handling across SQLite, MySQL, and PostgreSQL to avoid cross-database query mismatches.
- Improved dashboard, host, metrics, and forwarding-rule repository compatibility after database migration.

### Changed

- Bumped panel version to 2.3.127. Agent target version remains 2.2.90.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.127.

## [2.3.126] - 2026-06-12

### Fixed

- Improved dashboard traffic totals and recent traffic cards for migrated databases.
- Refined metrics aggregation and dashboard loading behavior across supported database engines.

### Changed

- Bumped panel version to 2.3.126. Agent target version remains 2.2.90.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.126.

## [2.3.125] - 2026-06-12

### Added

- Added database switching and setup support for SQLite, MySQL, and PostgreSQL, including migration helpers and Docker/local install script support.

### Removed

- Removed experimental iOS IPA build support from the release flow.

### Fixed

- Updated repositories, setup flow, forwarding groups, tunnels, hosts, billing, announcements, and token management to work across supported database engines.

### Changed

- Bumped panel version to 2.3.125. Agent target version remains 2.2.90.
- Android APP version remains 2.3.42 and the APK release pointer is updated to 2.3.125.

## [2.3.124] - 2026-06-12

### Added

- Added latency stability summary components and shared latency chart utilities.
- Added experimental iOS IPA build workflow support.

### Changed

- Bumped panel version to 2.3.124 and Agent target version to 2.2.90.
- Android APP version was bumped to 2.3.42.

## [2.3.123] - 2026-06-11

### Fixed

- Required sufficient balance before enabling traffic-billing rules so users cannot start balance-backed resources with no remaining funds.

### Changed

- Bumped panel version to 2.3.123. Agent target version remains 2.2.88.

## [2.3.122] - 2026-06-11

### Fixed

- Adjusted traffic billing settlement so deletion and disabling paths settle usage consistently before changing rule state.
- Improved rule group toggles, rule category filters, and dialog close hover behavior.

### Changed

- Bumped panel version to 2.3.122. Agent target version remains 2.2.88.

## [2.3.121] - 2026-06-11

### Fixed

- Fixed dynamic host address runtime sync so updated entry/internal addresses refresh dependent tunnels, rules, and forwarding chains.
- Fixed multi-hop tunnel latency aggregation.

### Changed

- Bumped panel version to 2.3.121. Agent target version remains 2.2.88.

## [2.3.120] - 2026-06-10

### Added

- Added support for non-systemd installs and clearer Agent test hints.

### Changed

- Bumped panel version to 2.3.120. Agent target version remains 2.2.88.

## [2.3.119] - 2026-06-10

### Fixed

- Polished authentication transitions and rule traffic globe paths.
- Added country layer support to the rule globe view.

### Changed

- Bumped panel version to 2.3.119. Agent target version remains 2.2.88.

## [2.3.118] - 2026-06-10

### Fixed

- Improved panel/Agent upgrade handling while GitHub Release assets are still pending build completion.

### Changed

- Bumped panel version to 2.3.118. Agent target version remains 2.2.88.

## [2.3.117] - 2026-06-10

### Changed

- Refreshed the login/auth experience and public home page styling.
- Added motion polish across the panel shell.
- Bumped panel version to 2.3.117. Agent target version remains 2.2.88.

## [2.3.116] - 2026-06-09

### Added

- Added host geo lookup, flat map, 3D globe map, and tunnel traffic globe views with improved map labels, country highlighting, route separation, and flow animation stability.

### Fixed

- Fixed installer scripts by removing BOM-related shell issues and adjusted panel release workflow triggering on main pushes.
- Improved deployment flow to use prebuilt panel artifacts for install and upgrade.

### Changed

- Bumped panel version to 2.3.116. Agent target version remains 2.2.88.

## [2.3.115] - 2026-06-08

### Added

- Added 24-hour latency charts and manual link self-tests for port forwarding chains, including per-hop Ping latency and final TCPing checks when a target rule is available.
- Added structured multi-hop latency output for tunnel and forwarding-chain self-tests, showing each hop and total latency.
- Added Agent-side Ping probe support for forwarding-chain latency collection.

### Fixed

- Fixed historical tunnel self-test failures triggering failure toasts when the user did not manually start a new test.
- Fixed multi-hop editor drag previews appearing offset below the cursor.

### Changed

- Bumped panel version to 2.3.115 and Agent/FXP runtime target version to 2.2.88.
- Android APP version remains 2.3.41 and the APK release pointer is updated to 2.3.115 because this is a web-panel/server and Agent update.

## [2.3.111] - 2026-06-06

### Added

- Added ForwardX custom encrypted relay chaining support, including multi-hop FXP relay routing.

### Fixed

- Moved port forwarding chains into tunnel management.
- Fixed port forwarding chain target resolution so rules use the selected internal connection address.
- Removed priority wording from internal tunnel address descriptions.
- Confirmed tunnel outbound strategies are applied through the Agent failover proxy for GOST and ForwardX encrypted tunnels.

### Changed

- Bumped panel version to 2.3.111 and Agent/FXP runtime target version to 2.2.87.
- Android APP version remains 2.3.40 and the APK release pointer is updated to 2.3.111 because this is a web-panel/server and Agent update.

## [2.3.110] - 2026-06-06

### Added

- Added administrator-managed descriptions for subscription plans and usage-based billing resources, with store fallback text when descriptions are empty.

### Fixed

- Fixed the usage-based billing resource tab opening the create dialog when administrators only switched to the tab.
- Fixed subscription plan resource selection to use dropdown-based adding with removable selected resources instead of listing every resource at once.

### Changed

- Lowered the minimum usage-based traffic price to 0.001/GB.
- Bumped panel version to 2.3.110. Agent/FXP runtime target version remains 2.2.86.
- Bumped Android APP version to 2.3.40 and updated the APK release pointer to 2.3.110.

## [2.3.109] - 2026-06-05

### Added

- Added separate store sections for subscription plans and usage-based billing resources.
- Added public display support for enabled usage-based resources so users can see multiplier pricing before using balance-backed resources.

### Fixed

- Improved local panel upgrade builds by requiring Go 1.22+ for Agent/FXP compilation and keeping newer local Go installs preferred over distro Go.
- Improved Agent installation and communication resilience with time synchronization handling for clock-skew related encrypted requests.

### Changed

- Merged subscription plan and billing resource creation into a single segmented management dialog.
- Moved billing resource management into Plan Management and removed duplicate billing deduction records from the billing resource page.
- Bumped panel version to 2.3.109 and Agent/FXP runtime target version to 2.2.86.
- Bumped Android APP version to 2.3.39 and updated the APK release pointer to 2.3.109.

## [2.3.105] - 2026-06-05

### Added

- Added Agent installation fallback support for GitHub acceleration and optional panel-first Agent installation.

### Changed

- Moved Agent Token management into Host Management with a Host / Token Management switch and unified the add-host flow around generating an Agent install command.
- Bumped panel version to 2.3.105. Agent/FXP runtime target version remains 2.2.83.
- Android APP version remains 2.3.38 and the APK release pointer is updated to 2.3.105 because this is a web-panel/server update.

## [2.3.103] - 2026-06-03

### Fixed

- Fixed GOST tunnels being interrupted by an overly broad idle cleanup action that could stop managed tunnel services after a panel-side misclassification.
- Fixed ForwardX custom multi-hop tunnels and their entry rules being repeatedly re-applied after all hops were already ready.
- Fixed multi-hop tunnel self-tests to refresh all hop runtimes before testing and to reuse repaired hop port data.

### Changed

- Bumped panel version to 2.3.103. Agent/FXP runtime target version remains 2.2.83.
- Android APP version remains 2.3.36 and the APK release pointer is updated to 2.3.103 because this is a web-panel/server update.

## [2.3.102] - 2026-06-03

### Added

- Added encrypted panel backup export/import and moved migration tools into a dedicated backup and restore settings tab.
- Added cached animated stat rendering across dashboard and management summaries to avoid blank-to-value flashes during data refreshes.

### Fixed

- Fixed latency chart dialogs reusing cached data and suppressing repeat mount animation so reopening tunnel and TCPing charts no longer flashes.
- Fixed the system settings tab strip alignment and kept the tab layout left-aligned.
- Fixed Agent installation during GitHub Release asset build windows by falling back to the previous release Agent binary for first install.
- Fixed panel and Agent log panes to keep stable scrollable viewports while older log pages load.
- Fixed imported or migrated panel data to preserve existing data incrementally while resetting imported runtime states for takeover.

### Changed

- Bumped panel version to 2.3.102. Agent/FXP runtime target version remains 2.2.83.
- Bumped Android APP version to 2.3.36 so the APK includes the latest panel UI and installer updates.

## [2.3.101] - 2026-06-03

### Changed

- Bumped panel version to 2.3.101 and Agent/FXP runtime target version to 2.2.83 for the latest panel loading, logging, and Agent communication updates.
- Android APP version remains 2.3.35 and the APK release pointer is updated to 2.3.101 because this is a web-panel and Agent update.

## [2.3.100] - 2026-06-02

### Added

- Added forwarding-rule card size selection with standard and compact cards for denser rule scanning.
- Added forwarding-rule page-size selection with 12, 24, 36, and 48 rules per page.

### Changed

- Bumped panel version to 2.3.100. Agent/FXP runtime target version remains 2.2.82.
- Bumped Android APP version to 2.3.35 so the APK includes the latest forwarding-rule card and pagination controls.

## [2.3.99] - 2026-06-02

### Fixed

- Added unified in-section loading states across data-backed management pages so lists and settings panels no longer flash misleading empty states while fetching.
- Fixed forwarding-rule protocol labels so TCP and UDP are shown explicitly instead of using a generic combined label.
- Grouped unfiltered forwarding rules by port forwarding, tunnel forwarding, and forward groups for easier scanning.
- Fixed network-test output panels to keep a stable fixed-height layout with scrollable result output instead of stretching the page.
- Bumped panel version to 2.3.99. Agent/FXP runtime target version remains 2.2.82.
- Android APP version remains 2.3.34 and the APK release pointer is updated to 2.3.99 because this is a web-panel update.

## [2.3.98] - 2026-06-02

### Fixed

- Fixed forwarding-rule and tunnel-management status columns wrapping too narrowly on desktop tables.
- Fixed ForwardX custom tunnels staying in the waiting state when a running tunnel rule had already confirmed the route was usable.
- Displayed the full multi-hop tunnel chain in tunnel cards, tunnel tables, forwarding-rule tunnel selectors, and related tunnel selection lists.
- Bumped panel version to 2.3.98 and Agent/FXP runtime target version to 2.2.82.

## [2.3.97] - 2026-06-02

### Fixed

- Fixed FXP tunnel entry rules being omitted from Agent `runningRules`, which caused the Agent reconciliation loop to remove a healthy `forwardx` listener after it had been running for a short time.
- Bumped panel version to 2.3.97 and Agent/FXP runtime target version to 2.2.81.

## [2.3.96] - 2026-06-02

### Fixed

- Fixed FXP tunnel refresh races by serializing Agent actions, dropping stale actions for the same port, and protecting ports with pending actions from state reconciliation cleanup.
- Reduced custom encrypted tunnel probe interference by skipping automatic TCPing for FXP entry rules and ignoring TCP probe connections that close before sending payload.
- Fixed collapsed sidebar spacing so icon-only navigation, theme toggle, and account avatar stay centered and do not overflow into the content area.
- Bumped panel version to 2.3.96 and Agent/FXP runtime target version to 2.2.80.

## [2.3.95] - 2026-06-02

### Fixed

- Fixed FXP multi-hop tunnel stability by preventing tunnel refresh actions from carrying unrelated GOST reload/cleanup commands.
- Hardened Agent FXP process adoption so already-running matching FXP runtimes are preserved after Agent state loss or restart instead of being killed and recreated.
- Bumped panel version to 2.3.95 and Agent/FXP runtime target version to 2.2.79.

## [2.3.94] - 2026-06-01

### Fixed

- Added FXP runtime diagnostics for custom encrypted tunnels, including startup route details and entry-side connection gate rejections.
- Bumped panel version to 2.3.94 and Agent target version to 2.2.78.

## [2.3.93] - 2026-06-01

### Fixed

- Fixed Android APK release publishing so panel releases whose Android app version is unchanged still attach the existing APK version to the current release tag.
- Bumped panel version to 2.3.93 and pointed the Android APK download URL at the matching release tag.

## [2.3.92] - 2026-06-01

### Fixed

- Added FXP wire-context fallback for the custom encrypted tunnel runtime so multi-hop chains continue working while some hops still have the v2.3.90 FXP binary.
- Added FXP runtime version logging at startup to make stale tunnel binaries visible in Agent logs.
- Bumped panel version to 2.3.92 and Agent target version to 2.2.77.
- Android APP version remains 2.3.34 and the APK release pointer is updated to 2.3.92 because this is an Agent/runtime compatibility fix.

## [2.3.91] - 2026-06-01

### Fixed

- Restored the established FXP wire encryption context for the current custom encrypted tunnel protocol so multi-hop chains keep working during rolling Agent upgrades.
- Changed Agent cleanup commands for FXP, socat, realm, and uninstall cleanup scripts so process matching cannot terminate the cleanup shell itself.
- Clarified Agent logs for matching already-running FXP runtimes so healthy reuse is no longer reported as missing local state.
- Bumped panel version to 2.3.91 and Agent target version to 2.2.76.
- Android APP version remains 2.3.34 and the APK release pointer is updated to 2.3.91 because this Agent cleanup fix does not require a native APP build.

## [2.3.90] - 2026-06-01

### Changed

- Removed the ForwardX FXP V1/V2 protocol selection and legacy V1 runtime path; custom encrypted tunnels now use a single current protocol.
- Bumped panel version to 2.3.90 and Agent target version to 2.2.75.
- Android APP version remains 2.3.34 and the APK release pointer is updated to 2.3.90 because this change does not require a native APP build.

### Fixed

- Prevented repeated Agent apply cycles from running disruptive cleanup commands against an already-running ForwardX custom encrypted tunnel.
- Kept live FXP processes intact when Agent local port state is missing but the runtime signature still matches, avoiding mid-test disconnects during long iperf3 runs.

## [2.3.89] - 2026-06-01

### Fixed

- Hardened Agent runtime handoff when a previously deleted port is reused or a listener switches between GOST and ForwardX custom encrypted tunnels.
- Made ForwardX FXP connections close stale half-open sessions cleanly, enable TCP keepalive, and avoid rejecting new sessions only because Agent host clocks are out of sync.
- Bumped panel version to 2.3.89 and Agent target version to 2.2.74 for the runtime handoff and FXP stability fixes.
- Android APP version remains 2.3.34 because this Agent/runtime fix does not require a native APP build.

## [2.3.88] - 2026-06-01

### Fixed

- Removed a stale iperf3 port state update that caused `setIperf3Port is not defined` when starting the iperf3 server from the network-test page.
- Bumped panel version to 2.3.88. Agent target version remains 2.2.73.
- Android APP version remains 2.3.34 and the APK release pointer is updated to 2.3.88 for the network-test UI fix.

## [2.3.87] - 2026-06-01

### Changed

- Changed iperf3 server startup so the Agent automatically selects an available listener port and the panel displays commands using that actual port.
- Kept the iperf3 idle shutdown at 3 minutes and removed the manual iperf3 port field from the network-test form.
- Added clearer Agent-side errors when an iperf3 listener port is unavailable and filtered pipe-close noise from iperf3 output.
- Bumped Android APP version to 2.3.34 so the APK includes the latest network-test UI.
- Bumped panel version to 2.3.87. Agent target version is now 2.2.73 for automatic iperf3 port selection.

## [2.3.86] - 2026-06-01

### Changed

- Moved iperf3 into the network-test type dropdown and removed the browser-based upload/download speed-test flow.
- Added Agent-managed iperf3 server tasks with client command display, one-test-at-a-time protection, and automatic shutdown after 3 minutes without client activity.
- Updated Agent install and upgrade scripts to install iperf3 as a required dependency.
- Bumped panel version to 2.3.86. Agent target version is now 2.2.72 for Agent-managed iperf3 server testing.
- Android APP version remains 2.3.33 because this web-panel and Agent change does not require a native APP build.

## [2.3.85] - 2026-06-01

### Changed

- Changed speed testing from fixed-size download links to an embedded 10-second download plus 10-second upload test inside the network-test page.
- Added animated real-time speed curves and live metrics for current, average, peak, and transferred upload/download data.
- Updated the Agent speed-test service to expose direct browser-to-Agent download and upload test endpoints with CORS support.
- Bumped panel version to 2.3.85. Agent target version is now 2.2.71 for embedded timed speed testing.
- Android APP version remains 2.3.33 because this web-panel and Agent change does not require a native APP build.

## [2.3.84] - 2026-06-01

### Changed

- Replaced Agent-hosted download-test links with direct browser-to-Agent speed-test pages.
- Added a real-time speed chart on the Agent speed-test page with current, average, peak, and transferred data metrics.
- Clarified network-test copy so users know speed-test traffic goes directly to the selected Agent host and does not pass through the panel.
- Bumped panel version to 2.3.84. Agent target version is now 2.2.70 for the direct speed-test service.
- Android APP version remains 2.3.33 because this web-panel and Agent change does not require a native APP build.

## [2.3.83] - 2026-06-01

### Added

- Added Agent-hosted network-test download links for 10 MB, 100 MB, and 1000 MB files using temporary signed URLs.
- Added live network-test progress updates from Agent execution output and showed the current visitor IP on the network-test card.

### Changed

- Renamed the user-facing network-test copy to 网络测试 and moved the sidebar entry below management.
- Changed network-test execution to use selected Agent hosts only and removed the current panel server as a test source.
- Reworked the network-test page to use a test-type dropdown and show queued/running progress text before final output arrives.
- Limited recent network-test history to the latest 4 results.
- Combined the System Settings network-test visibility switch with the branding row to keep the settings area compact.
- Bumped panel version to 2.3.83. Agent target version is now 2.2.69 for Agent-hosted download testing and live progress reporting.
- Android APP version remains 2.3.33 because this web-panel feature does not require a native APP build.

### Fixed

- Added clearer IPv6 validation so IPv6 tests immediately explain when the selected Agent host has no detected IPv6 address.

## [2.3.81] - 2026-06-01

### Added

- Added a ForwardX-styled Looking Glass page with Ping, Traceroute, MTR, and TCP port latency tests from the panel server.
- Added a System Settings switch so admins can decide whether Looking Glass is visible and usable for normal users.
- Added public-target validation for Looking Glass tests so private, loopback, link-local, multicast, and reserved addresses are rejected before execution.
- Added rule-level TCP failover with optional backup target rows, failover/recovery timing, and automatic failback.
- Added Looking Glass host selection so tests can run from the panel server or a selected Agent host.

### Changed

- Bumped panel version to 2.3.81. Agent target version is now 2.2.67 for failover proxying and Agent-side Looking Glass tests.
- Android APP version remains 2.3.33 because this web-panel feature does not require a native APP build.

## [2.3.80] - 2026-06-01

### Fixed

- Fixed sidebar navigation overlap on short browser heights by keeping menu groups from shrinking into each other and letting the navigation area scroll cleanly above the account footer.
- Kept the Android APK download URL pinned to the existing APP release when only the panel version changes.

### Changed

- Bumped panel version to 2.3.80. Agent target version remains 2.2.66.
- Android APP version remains 2.3.33 because this fix does not require a new native APP build.

## [2.3.79] - 2026-06-01

### Added

- Added the latest forwarding latency next to each rule's recent 24h traffic, including mobile cards and desktop table views.
- Added editable traffic billing configuration dialogs with permission-mode control, allowing public balance-based billing items or permission-required items.

### Fixed

- Kept rule latency visible even when a rule has no recent 24h traffic by loading the latest TCPing result for the visible rule set.
- Fixed select-menu scroll locking so opening dropdowns no longer causes page-width flicker.
- Improved Profile, Settings, Traffic Billing, and User Management mobile layout alignment for APP/WebView screens.

### Changed

- Traffic billing permission assignment now only lists resources that explicitly require permission.
- Bumped panel version to 2.3.79. Agent target version remains 2.2.66.
- Bumped Android APP version to 2.3.33 so the APK includes the latest rule latency and mobile UI updates.

## [2.3.78] - 2026-06-01

### Fixed

- Fixed Telegram bind-code copy on browsers and APP WebViews where the Clipboard API is unavailable by adding a fallback copy path.
- Kept Profile Telegram binding status live while a bind code is pending so successful bot binding is reflected without refreshing.
- Improved Profile mobile and desktop layout alignment for account, avatar, Telegram, and 2FA cards.

### Changed

- Simplified system branding settings to edit only the website title and no longer expose Logo editing.
- Refined User Management account rows so role information is shown with the account and account status/actions are aligned more cleanly.
- Bumped panel version to 2.3.78. Agent target version remains 2.2.66.
- Bumped Android APP version to 2.3.32 so the APK includes the latest Profile, Settings, and User Management mobile UI updates.

## [2.3.77] - 2026-05-31

### Added

- Added an administrator account enable/disable control for users. Disabled accounts can no longer log in, active sessions are invalidated, and the user is shown a clear disabled-account message.
- Added an administrator action to remove a user's bound 2FA after confirmation when the user loses access.
- Added editable display names separate from administrator remarks, with account menus and user-facing dashboard labels preferring the display name.

### Changed

- Disabling an account now invalidates that user's active forwarding rules without changing the independent forwarding master switch; re-enabled users must manually start rules again.
- Reworked User Management mobile actions into account status, edit, and more menus with shorter mobile status labels.
- Changed traffic/resource permission editing to add selected hosts/tunnels on demand instead of rendering every resource by default.
- Updated the Android APK direct download URL to point at the current panel release asset.
- Bumped panel version to 2.3.77. Agent target version remains 2.2.66.
- Bumped Android APP version to 2.3.31 so the APK includes the latest account and mobile UI updates.

## [2.3.76] - 2026-05-31

### Fixed

- Kept generated Telegram bind codes visible across Profile page refreshes and APP/WebView remounts by returning the active pending bind code from the Telegram status API.
- Changed Telegram bind codes to a 5-minute validity window with an on-screen countdown, copy action, expired state, and regenerate action.
- Added a direct Telegram jump link that opens the configured bot with the bind code so users can complete binding from the Start flow.

### Changed

- Moved Profile to the first item in the Management sidebar group.
- Placed Telegram binding and 2FA cards on the same row on wide Profile layouts while keeping mobile screens stacked.
- Bumped panel version to 2.3.76. Agent target version remains 2.2.66.
- Bumped Android APP version to 2.3.30 so the APK includes the latest Profile binding UI.

## [2.3.75] - 2026-05-31

### Fixed

- Unified the Profile sidebar item with the Management group styling so it aligns with User Management, System Settings, and other management entries.
- Removed the Profile page's separate centered content width so its left edge and page rhythm match the rest of the admin pages.
- Prevented the account menu Profile navigation from causing a scrollbar-related page flicker.
- Changed the account menu software update action to show a simple "already latest" toast when the panel has no available update instead of opening the upgrade dialog.

### Changed

- Bumped panel version to 2.3.75. Agent target version remains 2.2.66.
- Bumped Android APP version to 2.3.29 so the APK includes the latest sidebar/profile UI refinements.

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
