# 常见问题排查

> 当前版本：面板 2.3.264 / Agent 2.2.179 / Android APP 2.3.96

---

## 目录

- [日志位置速查](#日志位置速查)
- [面板问题](#面板问题)
- [Agent 问题](#agent-问题)
- [规则与转发问题](#规则与转发问题)
- [隧道问题](#隧道问题)
- [mimic UDP 混淆](#mimic-udp-混淆)

---

## 日志位置速查

| 组件 | 日志路径 | 查看命令 |
|------|----------|----------|
| 面板（systemd） | journald | `journalctl -u forwardx-panel -n 300 --no-pager` |
| 面板（Docker） | 容器日志 | `docker logs -n 300 forwardx-panel` |
| Agent | `/var/log/forwardx-agent/` | `journalctl -u forwardx-agent -n 300 --no-pager` |
| Agent 配置 | `/etc/forwardx/agent/config.json` | — |
| Agent 数据 | `/var/lib/forwardx-agent/` | — |

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
- 反向代理配置错误，未正确转发 `/api/*` 和 WebSocket。
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
   journalctl -u forwardx-agent -n 300 --no-pager
   ```

2. 确认 Agent 配置中的面板地址正确：
   ```bash
   cat /etc/forwardx/agent/config.json
   ```

   旧版本路径为 `/etc/forwardx-agent/config.json`，升级脚本会自动迁移到 `/etc/forwardx/agent/config.json`。

3. 在 Agent 主机上测试是否能访问面板：
   ```bash
   curl -v http(s)://面板公开地址/api/agent/ping
   ```

4. 确认面板后台"系统设置 - 公开地址"填写正确，协议（HTTP/HTTPS）与实际访问方式一致。

**常见原因：**

- 面板公开地址填写错误（旧 IP、旧端口）。
- Agent 配置中仍使用旧地址，手动改完后又被面板下发覆盖。
  - 根本修复：先在面板后台修正公开地址，再重新执行 Agent 升级命令。
- 反向代理未正确转发 `/api/agent/*` 路径。
- HTTP/HTTPS 协议不一致（面板用 HTTPS，Agent 配置仍写 HTTP）。
- Token 错误或已被删除。
- Agent 主机网络不通，无法访问面板。

---

### Docker 升级后 Agent 全部离线

此情况通常由面板地址变更引起，按以下顺序排查：

1. 面板后台确认公开地址是否填写了正确域名（而非旧 IP）。
2. 如果使用反向代理 HTTPS，公开地址是否也是 `https://`。
3. 反向代理是否正常转发 `/api/agent/*`（含 WebSocket 升级头）。
4. Agent 配置 `/etc/forwardx/agent/config.json` 是否还在使用旧地址。

修复步骤：先在面板后台修正公开地址，再对各 Agent 主机重新执行升级命令。

---

### Agent 频繁上下线（抖动）

1. 查看 Agent 日志中是否有反复 connect / disconnect 记录。
2. 检查面板日志是否有 apply/remove 频繁循环。
3. 确认面板和 Agent 版本兼容，必要时同步升级。
4. 如为孤儿迟滞问题（apply 后 worker 未及时就绪即触发 remove），升级到包含 A1 修复的版本。

---

## 规则与转发问题

### 转发不通

**按顺序排查：**

1. 规则是否已启用（面板中显示绿色）。
2. 入口端口是否在 Agent 主机防火墙放行。
3. 目标地址和目标端口是否填写正确。
4. 目标服务本身是否可被 Agent 主机访问：
   ```bash
   nc -vz 目标地址 目标端口
   ```
5. 查看 Agent 日志是否有规则执行失败记录：
   ```bash
   journalctl -u forwardx-agent -n 300 --no-pager
   ```
6. 面板链路测试页面查看哪一段失败。

**抓包确认流量是否到达：**

```bash
tcpdump -ni any 'port 入口端口'
```

---

### 规则显示黄色

黄色通常表示规则状态检测中、状态不完整，或流量统计未正常确认。

**排查步骤：**

1. 查看 Agent 日志：
   ```bash
   journalctl -u forwardx-agent -n 300 --no-pager
   ```

2. 检查 nftables/iptables 规则是否存在：
   ```bash
   nft -a list table inet forwardx
   iptables -t nat -S
   ip6tables -t nat -S
   ```

3. 如果转发能通但状态异常，重点检查流量统计规则是否存在、计数是否在增长。

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
   journalctl -u forwardx-agent -n 300 --no-pager
   ```
2. 确认 GOST 端口未被其他进程占用：
   ```bash
   ss -tlnp | grep 端口号
   ```
3. 确认两端版本兼容（GOST 协议参数是否一致）。

> 注意：forwardx-runtime 重命名后，Agent 通过进程名 needle 检查 GOST 是否就绪。如遇到端口已绑定但 ready-check 误判失败、cleanup 强杀、worker 死循环的情况，请升级到包含 gost ready-check needle 修复的 Agent 版本。

---

### FXP V1/V2 隧道异常

1. 确认两端 Agent 版本支持对应隧道协议。
2. 查看 Agent 日志中隧道握手阶段的错误。
3. 确认中间链路没有 MTU 限制或协议过滤。

---

### Nginx Stream 隧道

1. 确认 Agent 主机上 Nginx 已安装且 `stream` 模块可用：
   ```bash
   nginx -V 2>&1 | grep stream
   ```
2. 检查 Agent 生成的 Nginx 配置是否正确加载：
   ```bash
   nginx -t
   journalctl -u nginx -n 100 --no-pager
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
- 支持 XDP 或 TC eBPF（取决于网卡驱动）。

**检查内核版本：**

```bash
uname -r
```

如果内核低于 6.1，mimic 无法加载，需升级内核或更换主机。

---

### mimic 加载失败

1. 查看 Agent 日志中 mimic 相关错误：
   ```bash
   journalctl -u forwardx-agent -n 300 --no-pager
   ```
2. 确认 eBPF 相关内核模块已加载：
   ```bash
   lsmod | grep -E 'xdp|bpf'
   ```
3. 确认网卡支持 XDP（部分虚拟化环境仅支持 TC 模式）：
   ```bash
   ethtool -i 网卡名
   ```
4. 部分云主机需要在宿主机层面开启 eBPF 支持，联系云服务商确认。

---

### mimic 混淆后连接不稳定

1. 确认两端 mimic 版本一致（v0.7.1）。
2. 检查中间网络是否对 UDP 特征流量进行了限速或拦截。
3. 尝试切换 XDP/TC 模式（在 Agent 规则配置中调整）。
4. 查看 Agent 日志中 mimic 的错误或丢包统计。

---

## 通用排查思路

1. **先看日志**：Agent 日志和面板日志覆盖了绝大多数问题的直接原因。
2. **确认版本**：面板、Agent、APP 保持兼容版本，跨大版本升级前查阅更新日志。
3. **网络连通性**：使用 `nc`、`curl`、`ping` 在故障节点上直接测试，排除网络层问题。
4. **防火墙**：入口端口、面板端口、Agent 与面板通信端口均需放行。
5. **协议一致性**：HTTP/HTTPS、端口、域名在面板配置、Agent 配置、反向代理三处保持一致。
