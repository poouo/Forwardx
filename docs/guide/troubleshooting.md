# 常见问题排查

> 当前版本：面板 2.3.266 / Agent 2.2.181 / Android APP 2.3.97

---

## 目录

- [三分钟快速排查](#三分钟快速排查)
- [日志位置速查](#日志位置速查)
- [收集诊断信息](#收集诊断信息)
- [面板问题](#面板问题)
- [Agent 问题](#agent-问题)
- [规则与转发问题](#规则与转发问题)
- [隧道问题](#隧道问题)
- [mimic UDP 混淆](#mimic-udp-混淆)
- [通用排查思路](#通用排查思路)

---

## 三分钟快速排查

遇到故障时，先记录**发生时间（含时区）、主机 ID、规则/隧道 ID、入口端口和协议**。不要立即重装 Agent、清空日志或刷新全部防火墙规则，否则会丢失现场信息。

### 先判断故障在哪一层

| 现象 | 优先检查 |
|------|----------|
| 面板打不开 | 面板进程/容器、9810 监听、防火墙、反向代理、数据库日志 |
| Agent 离线 | Agent 服务、面板公开地址、DNS/TLS、challenge-v2、Token |
| 规则没有监听 | Agent 是否在线、规则是否下发、端口占用、对应运行时服务 |
| 端口已监听但不通 | 入口防火墙、目标连通性、入口与出口抓包、协议是否一致 |
| 转发正常但流量不增长 | 发起真实流量后检查 iptables/nftables 计数器与 Agent 日志 |
| 延迟或链路测试失败 | 从链路图第一段失败的位置开始，逐跳测试下一跳地址和端口 |
| CPU/内存突然升高 | 找到占用进程，再检查重启次数、连接重试、域名/TLS 和内核日志 |

### 面板主机上

```bash
# Docker 部署
docker ps --filter name=forwardx-panel
docker logs --since 30m --timestamps forwardx-panel | tail -n 300
ss -lntp | grep ':9810'

# systemd 部署
systemctl status forwardx-panel --no-pager -l
journalctl -u forwardx-panel -b --since '-30 min' -n 300 --no-pager -o short-iso
```

### Agent 主机上

```bash
# 仅旧版 v1 认证兼容排查时需要重点核对时间
date -u
systemctl status forwardx-agent --no-pager -l
tail -n 300 /var/log/forwardx-agent/agent-go.log
journalctl -u forwardx-agent -b --since '-30 min' -n 300 --no-pager -o short-iso
systemctl show forwardx-agent -p ActiveState -p SubState -p NRestarts -p ExecMainStartTimestamp
ss -H -lntup
```

### 检查一条不通的规则

将下列占位内容替换成实际值：

```bash
# 进程转发模式的入口是否监听（iptables/nftables 内核 NAT 不会显示用户态监听进程）
ss -H -lntup | grep -E ':(入口端口)\b'

# Agent 到最终目标是否可达；nc -vz 只适用于 TCP
nc -vz -w 3 目标地址 目标端口
nc -zvu -w 3 目标地址 目标端口   # UDP 结果只能作为参考

# 是否有流量到达入口
tcpdump -ni any 'tcp port 入口端口 or udp port 入口端口'
```

如果入口没有数据包，优先检查客户端地址、DNS、安全组和入口防火墙；入口有包但目标侧没有，检查转发规则和运行时；目标侧有包但没有回包，检查目标服务及其回程路由。

---

## 日志位置速查

| 组件 | 位置 | 查看命令 |
|------|------|----------|
| 面板网页日志 | 系统设置 → 面板日志（最近 24 小时） | 可按等级筛选或导出 |
| 面板持久日志（Docker） | 容器内 `/data/logs/panel.jsonl` | `docker exec forwardx-panel tail -n 300 /data/logs/panel.jsonl` |
| 面板持久日志（非 Docker） | `<面板工作目录>/data/logs/panel.jsonl` | `tail -n 300 data/logs/panel.jsonl` |
| 面板自定义日志目录 | `$FORWARDX_LOG_DIR/panel.jsonl` | `tail -n 300 "$FORWARDX_LOG_DIR/panel.jsonl"` |
| 面板（Docker） | 容器标准输出 | `docker logs --since 30m --timestamps forwardx-panel` |
| 面板（systemd） | journald | `journalctl -u forwardx-panel -b -n 300 --no-pager` |
| Agent 主日志 | `/var/log/forwardx-agent/agent-go.log` | `tail -n 300 /var/log/forwardx-agent/agent-go.log` |
| Agent（当前启动） | journald | `journalctl -u forwardx-agent -b -n 300 --no-pager` |
| Agent（上一次启动） | journald | `journalctl -u forwardx-agent -b -1 -n 300 --no-pager` |
| GOST/隧道运行时 | `forwardx-runtime`、`forwardx-tunnel-runtime` | `journalctl -u forwardx-runtime -u forwardx-tunnel-runtime -b -n 300 --no-pager` |
| Nginx Stream 服务 | `forwardx-nginx.service` | `journalctl -u forwardx-nginx -b -n 300 --no-pager` |
| Nginx Stream 运行时 | `/var/log/forwardx-agent/forwardx-nginx-error.log` | `tail -n 300 /var/log/forwardx-agent/forwardx-nginx-error.log` |
| Nginx 会话日志 | `/var/log/forwardx-agent/forwardx-nginx-session.log` | `tail -n 300 /var/log/forwardx-agent/forwardx-nginx-session.log` |
| mimic 网卡服务 | `mimic@<网卡>.service` | `journalctl -u 'mimic@ens3.service' -b -n 300 --no-pager` |
| OpenRC/SysV 托管运行时 | `/var/log/forwardx-agent/<服务名>.log` | `tail -n 300 /var/log/forwardx-agent/<服务名>.log` |

面板的 `panel.jsonl` 默认位于 `/data/logs`（容器）或工作目录下的 `data/logs`，也可通过 `FORWARDX_LOG_DIR` 修改。Docker 启动/数据库连接错误通常先出现在 `docker logs`，业务运行记录则可在网页日志或 `panel.jsonl` 中查看。

### 相关配置和状态位置

| 用途 | 路径 |
|------|------|
| Agent 通讯配置 | `/etc/forwardx/agent/config.json` |
| GOST/隧道运行时配置 | `/etc/forwardx/runtime/` |
| Nginx 配置和证书 | `/etc/forwardx/nginx/` |
| Realm 配置 | `/etc/forwardx/realm/` |
| mimic 配置 | `/etc/mimic/` |
| Agent 运行状态和计数基线 | `/var/lib/forwardx-agent/` |
| Docker 面板默认部署目录 | `/opt/forwardx-docker/` |

配置文件可能包含 Token、证书私钥或目标信息。排查时可以本机查看，但不要未经脱敏直接发给他人。

---

## 收集诊断信息

管理员可进入**系统设置 → 面板日志**：

![在面板日志右上角筛选、导出日志或生成支持包](./images/troubleshooting-logs.png)

- 使用“导出日志”保存当前筛选的面板日志。
- 使用“生成支持包”收集面板日志、配置审计和在线 Agent 的脱敏诊断。离线 Agent 无法返回完整数据。

提交故障信息时至少附带：

1. 故障发生时间和时区，以及是否可稳定复现。
2. 面板、Agent 版本，部署方式（Docker/systemd）和数据库类型。
3. 主机 ID、规则/隧道 ID、协议和端口，不要只提供页面截图。
4. 故障前后的相关日志各 1 至 3 分钟，保留第一条错误及其前后文。
5. 已执行的检查命令和结果，说明“入口未收到包”“目标无回包”等具体位置。

不要发送管理员密码、Agent Token、Cookie、2FA Secret、数据库密码、证书私钥或完整未脱敏配置。日志太多时先按时间和资源 ID 筛选，不要只截取最后一行错误。

---

## 面板问题

### 面板打不开

**排查步骤：**

1. 确认服务正在运行：

   Docker 部署：
   ```bash
   docker ps
   docker logs -n 300 forwardx-panel
   ```

   systemd 部署：
   ```bash
   systemctl status forwardx-panel
   journalctl -u forwardx-panel -n 300 --no-pager
   ```

2. 确认端口已监听（面板默认端口 9810）：
   ```bash
   ss -tlnp | grep 9810
   ```

3. 确认防火墙已放行对应端口：
   ```bash
   # firewalld
   firewall-cmd --list-ports
   # iptables
   iptables -L INPUT -n
   ```

4. 如使用反向代理，检查 Nginx/Caddy 配置是否正确代理到本地端口。

**常见原因：**

- 面板服务未启动或启动失败。
- 端口（默认 9810）未在防火墙放行。
- 反向代理配置错误，未完整转发 `/api/*`，或缓存、缓冲了 Agent 的 SSE 与认证请求。
- 数据库连接失败（查看日志中的 connection refused / no such file）。
- Docker 镜像拉取不完整，容器启动后立即退出。

---

### 面板升级后页面空白或功能异常

强制刷新浏览器缓存（Ctrl+Shift+R 或清除缓存后重试）。如仍有问题，查看浏览器控制台网络请求是否有 4xx/5xx 错误，再结合面板日志排查。

---

## Agent 问题

### Agent 离线

**排查步骤：**

1. 查看 Agent 日志：
   ```bash
   tail -n 300 /var/log/forwardx-agent/agent-go.log
   journalctl -u forwardx-agent -n 300 --no-pager
   ```

   `agent-go.log` 是正常运行时的主日志；journald 主要用于查看服务启动和标准错误。

2. 确认 Agent 配置中的面板地址正确：
   ```bash
   cat /etc/forwardx/agent/config.json
   ```

   旧版本路径为 `/etc/forwardx-agent/config.json`，升级脚本会自动迁移到 `/etc/forwardx/agent/config.json`。

3. 在 Agent 主机上测试是否能访问面板：
   ```bash
   getent ahosts panel.example.com
   curl -fsS -D - --connect-timeout 5 \
     'https://panel.example.com/api/agent/auth-challenge?count=1'
   ```

   正常应返回 HTTP 200、JSON 中包含 `"v":2`，响应头包含 `X-ForwardX-Agent-Auth: challenge-v2`。仅返回前端 HTML 不代表 Agent API 可用。

4. 确认面板后台"系统设置 - 公开地址"填写正确，协议（HTTP/HTTPS）与实际访问方式一致。

**常见原因：**

- 面板公开地址填写错误（旧 IP、旧端口）。
- Agent 配置中仍使用旧地址，手动改完后又被面板下发覆盖。
  - 根本修复：先在面板后台修正公开地址，再重新执行 Agent 升级命令。
- 反向代理未完整转发 `/api/*`，尤其是 `/api/stream`、`/api/sync` 和 `/api/agent/*`。
- CDN 或反向代理缓存了一次性 challenge，或对 SSE 启用了响应缓冲和短读取超时。
- HTTP/HTTPS 协议不一致（面板用 HTTPS，Agent 配置仍写 HTTP）。
- Token 错误或已被删除。
- Agent 主机网络不通，无法访问面板。

---

### 注册提示 401 或时间超出窗口

当前版本使用 challenge-v2 无时钟认证，正常注册不依赖 Agent 与面板的系统时间一致。遇到 401 或旧日志中的 `Request timestamp out of window (replay protection)` 时，按以下顺序检查：

1. 面板和 Agent 是否都已升级到当前兼容版本。
2. 在 Agent 主机执行 challenge 测试，确认返回 HTTP 200、JSON `"v":2` 和响应头 `X-ForwardX-Agent-Auth: challenge-v2`。
3. CDN/反向代理是否完整转发 `/api/*`，没有缓存一次性 challenge、剥离认证头或改写请求。
4. Token 是否由当前面板实例生成，且未被删除或替换。

只有旧版 v1 Agent/FXP，或 challenge-v2 确实不可用而回退旧认证时，才需要重点检查 Agent、面板宿主机和面板容器的 UTC 时间：

```bash
# Agent 和面板宿主机分别执行
date -u
timedatectl status

# Docker 面板额外执行
docker exec forwardx-panel date -u
```

旧认证模式下两端时间应基本一致。可在支持 systemd-timesyncd 的系统上尝试：

```bash
timedatectl set-ntp true
systemctl restart systemd-timesyncd 2>/dev/null || true
timedatectl timesync-status 2>/dev/null || true
```

使用 chrony 的系统改为检查 `chronyc tracking`。Docker 容器共享宿主机内核时间，不能在容器内维护一套独立时钟；旧认证需要校时时应校准宿主机。不要用调整系统时间代替 challenge-v2、代理配置和 Token 检查。

---

### Docker 升级后 Agent 全部离线

此情况通常由面板地址变更引起，按以下顺序排查：

1. 面板后台确认公开地址是否填写了正确域名（而非旧 IP）。
2. 如果使用反向代理 HTTPS，公开地址是否也是 `https://`。
3. 反向代理是否完整转发 `/api/*`；Agent 即时通道是 SSE，`/api/stream`、`/api/sync` 需要关闭 buffering/cache 并延长读取超时，一次性 challenge 也不能缓存。
4. Agent 配置 `/etc/forwardx/agent/config.json` 是否还在使用旧地址。

修复步骤：先在面板后台修正公开地址，再对各 Agent 主机重新执行升级命令。

---

### Agent 频繁上下线（抖动）

1. 查看 Agent 日志中是否有反复连接、DNS、TLS 或超时记录。
2. 检查面板日志是否有规则反复应用/移除或 Agent 重连记录。
3. 确认面板和 Agent 版本兼容，必要时同步升级。
4. 查看服务是否不断重启：

   ```bash
   systemctl show forwardx-agent -p NRestarts -p ExecMainStartTimestamp
   tail -n 300 /var/log/forwardx-agent/agent-go.log
   journalctl -u forwardx-agent -b --since '-30 min' --no-pager | tail -n 300
   ```

5. 确认面板域名仍能解析、证书未过期，公开地址没有指向旧实例。

---

### Agent 主机 CPU 或内存异常

先找到实际占用进程，不要直接反复重启：

```bash
ps -eo pid,ppid,comm,%cpu,%mem,etime --sort=-%cpu | head -n 20
free -h
df -h
systemctl show forwardx-agent forwardx-runtime forwardx-tunnel-runtime forwardx-nginx \
  -p Id -p ActiveState -p SubState -p NRestarts
```

如果占用进程是 Agent 或转发运行时，检查同一时间段是否持续出现域名解析失败、证书过期、连接超时、端口占用或服务重启。域名失效可能触发连接重试，具体频率应以日志为准：

```bash
getent ahosts 相关域名
curl -vI --connect-timeout 5 https://相关域名/
journalctl -u forwardx-agent -b --since '-30 min' --no-pager \
  | grep -Ei 'error|failed|timeout|refused|x509|certificate|resolve|dns|restart' \
  | tail -n 200
```

再检查内核是否出现 OOM、连接跟踪表满或网络内存异常：

```bash
journalctl -k -b --since '-2 hours' --no-pager \
  | grep -Ei 'out of memory|oom|killed process|nf_conntrack.*(full|drop)|TCP:.*memory' \
  | tail -n 200
```

排查完成后关闭 `FORWARDX_AGENT_VERBOSE_LOG` 和 `FORWARDX_FXP_VERBOSE_LOG` 等详细日志开关，避免长期记录会话明细。

---

## 规则与转发问题

### 转发不通

**按顺序排查：**

1. 规则是否已启用，界面是否显示“运行中”或“可用”；“等待探测”表示尚无探测结果，不等于转发失败。
2. Realm、Socat、GOST、Nginx、FXP 等进程转发模式检查入口端口是否监听，并确认没有被其他程序占用。iptables/nftables 是内核 NAT，本来就没有用户态监听进程：
   ```bash
   ss -H -lntup | grep -E ':(入口端口)\b'
   systemctl list-units --type=service --all | grep -E 'forwardx|mimic@'
   ```
3. 入口端口是否在云安全组和 Agent 主机防火墙放行。
4. 目标地址和目标端口是否填写正确。
5. 目标服务本身是否可被 Agent 主机访问：
   ```bash
   nc -vz -w 3 目标地址 目标端口
   ```
6. 查看 Agent 日志是否有规则执行失败记录：
   ```bash
   tail -n 300 /var/log/forwardx-agent/agent-go.log
   journalctl -u forwardx-agent -n 300 --no-pager
   ```
7. 面板链路测试页面查看哪一段失败，从第一段失败位置开始逐跳检查。

**抓包确认流量是否到达：**

```bash
tcpdump -ni any 'port 入口端口'
```

---

### 规则状态异常或流量不增长

先区分界面状态：“等待探测”表示尚无探测结果；“检测中”表示本轮探测尚未结束；“部分可用”表示部分入口或分支失败；“不可用”才表示最近一次检测失败；“停用”表示规则未启用。首次进入页面还未发起探测时显示“等待探测”不是故障。

**排查步骤：**

1. 查看 Agent 日志：
   ```bash
   journalctl -u forwardx-agent -n 300 --no-pager
   ```

2. 先发起一段真实业务流量，再检查 nftables/iptables 规则和字节计数。间隔数秒执行两次，确认 `bytes` 是否增长：
   ```bash
   nft -a list table inet forwardx
   nft -a list table inet forwardx_traffic
   iptables -t mangle -nvxL | grep -E 'fwx-stat-|FWX_(IN|OUT)_'
   ip6tables -t mangle -nvxL | grep -E 'fwx-stat-|FWX_(IN|OUT)_'
   ```

3. `forwardx` 主要覆盖 nftables 原生转发，`forwardx_traffic` 用于 Realm、Socat、GOST、Nginx、FXP 等进程转发的 nft 计数。iptables 转发规则主要位于 `nat` 表，流量统计主要位于 `mangle` 表；只查看 `iptables -t nat -S` 不能判断统计计数是否正常。
4. 如果转发能通但计数始终为零，在 Agent 日志中查找 `traffic diag missing counters`，并记录规则 ID、入口端口、IPv4/IPv6 和当前转发工具后再反馈。
5. 不要为了排查直接执行 `iptables -F`、`nft flush ruleset` 或清空计数器，这会中断现有转发并破坏现场。

---

### IPv6 转发问题

**检查主机 IPv6 可用性：**

```bash
# 查看公网 IPv6 地址
ip -6 addr show scope global

# 查看 IPv6 路由
ip -6 route

# 测试 IPv6 出站
ping -6 -c 4 2606:4700:4700::1111

# 确认内核转发已开启
sysctl net.ipv6.conf.all.forwarding
```

**抓包：**

```bash
tcpdump -ni any 'ip6 and port 入口端口'
```

如果服务器只有内网 IPv6 或 IPv6 不可出站，面板可能无法将该主机作为 IPv6 入口展示。

---

## 隧道问题

### GOST 隧道无法建立

1. 查看 Agent 日志中 GOST 进程的启动和错误信息：
   ```bash
   tail -n 300 /var/log/forwardx-agent/agent-go.log
   journalctl -u forwardx-agent -n 300 --no-pager
   journalctl -u forwardx-runtime -u forwardx-tunnel-runtime -b -n 300 --no-pager
   ```
2. 确认 GOST 端口未被其他进程占用：
   ```bash
   ss -lntup | grep 端口号
   ```
3. 确认两端版本兼容（GOST 协议参数是否一致）。
4. 面板和 Agent 版本较旧时先同步升级，再重新下发隧道配置。

---

### FXP V1/V2 隧道异常

1. 确认两端 Agent 版本支持对应隧道协议。
2. 查看 Agent 日志中隧道握手阶段的错误。
3. 确认中间链路没有 MTU 限制或协议过滤。

---

### Nginx Stream 隧道

ForwardX 使用独立运行时，与系统的 `nginx` 命令和 `nginx.service` 无关：

1. 确认独立服务和二进制存在：
   ```bash
   systemctl status forwardx-nginx --no-pager -l
   /usr/local/bin/forwardx-nginx -V
   ```
2. 检查 Agent 生成的配置、服务日志和专用运行时日志：
   ```bash
   /usr/local/bin/forwardx-nginx -p /etc/forwardx/nginx \
     -c /etc/forwardx/nginx/nginx.conf -t
   journalctl -u forwardx-nginx -b -n 100 --no-pager
   tail -n 100 /var/log/forwardx-agent/forwardx-nginx-error.log
   tail -n 100 /var/log/forwardx-agent/forwardx-nginx-session.log
   ```

---

### DDNS 故障转移不切换

1. 确认 DDNS 记录更新权限和 API Token 正确。
2. 查看面板日志中 DDNS 检测和切换记录。
3. 确认探测间隔和阈值配置符合预期。

---

## mimic UDP 混淆

> mimic 来源：[hack3ric/mimic](https://github.com/hack3ric/mimic)，协议 GPL-2.0-only，当前版本 v0.7.1。

### 前置要求

- Linux 内核 **6.1 或以上**。
- 入站需要 XDP，出站需要 TC eBPF；Agent 会在 XDP `native` 和 `skb` 模式间自动回退。

**检查内核版本：**

```bash
uname -r
```

如果内核低于 6.1，mimic 无法加载，需升级内核或更换主机。

---

### mimic 加载失败

先确认面板配置使用的真实网卡名，例如 `ens3`、`eth0` 或 `enp3s0`：

```bash
ip -br link
```

1. 同时查看 Agent 和对应网卡的 mimic 服务日志：
   ```bash
   systemctl status 'mimic@ens3.service' --no-pager -l
   journalctl -u forwardx-agent -u 'mimic@ens3.service' -b -n 300 --no-pager
   ```
2. 服务进程存在不等于网卡钩子可用，必须确认 `mimic show` 能正常返回：
   ```bash
   mimic show ens3
   ip -details -statistics link show dev ens3
   tc filter show dev ens3 ingress
   tc filter show dev ens3 egress
   ```
3. 检查对应配置和网卡驱动能力（配置内容可能包含目标地址，分享前先脱敏）：
   ```bash
   ls -l /etc/mimic/
   ethtool -i ens3
   ethtool -k ens3
   ```
4. 查看内核是否拒绝加载 BPF/XDP/TC 程序：
   ```bash
   journalctl -k -b --no-pager | grep -Ei 'mimic|bpf|xdp|tc|verifier' | tail -n 200
   ```
5. 部分虚拟化网卡不支持 XDP `native`，Agent 会自动回退到 XDP `skb`；如果两种模式都不可用，或云平台禁止 eBPF，则 mimic 无法工作。

---

### mimic 混淆后连接不稳定

1. 确认两端 mimic 版本一致（v0.7.1）。
2. 在两端分别执行 `mimic show 网卡名`，确认启动、关闭、再次启动后钩子仍存在。
3. 查看 `mimic@网卡.service` 的 `NRestarts` 和同一时间段日志，确认没有启动成功后立即退出。
4. 先确认未启用 mimic 时普通 UDP 链路可用，再检查中间网络是否限速或拦截 UDP。
5. 对域名端点执行 `getent ahosts 域名`，确认解析结果没有过期或指向旧 IP。
6. 检查两端 MTU、网卡丢包、XDP 入站和 TC 出站统计：

   ```bash
   ip -s link show dev ens3
   tc -s filter show dev ens3 ingress
   tc -s filter show dev ens3 egress
   ```

切换开关后不要只看面板显示“运行中”，还要结合 `mimic show`、服务日志和实际 UDP 流量确认。

---

## 通用排查思路

1. **先看日志**：Agent 日志和面板日志覆盖了绝大多数问题的直接原因。
2. **确认版本**：面板、Agent、APP 保持兼容版本，跨大版本升级前查阅更新日志。
3. **网络连通性**：使用 `nc`、`curl`、`ping` 在故障节点上直接测试，排除网络层问题。
4. **防火墙**：入口端口、面板端口、Agent 与面板通信端口均需放行。
5. **协议一致性**：HTTP/HTTPS、端口、域名在面板配置、Agent 配置、反向代理三处保持一致。
6. **保留现场**：先收集时间、ID、日志、监听和计数器，再进行重启、重装或规则重建。
