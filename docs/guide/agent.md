# 安装 Agent

Agent 是安装在被管理服务器上的程序，负责执行转发规则、上报主机状态、统计流量和执行链路测试。

当前版本：Agent 2.2.176

---

## 创建 Agent Token

进入：

```
主机管理 → Token 管理
```

点击"添加主机"创建新的 Agent Token。Token 用于允许服务器注册到当前面板。

**建议一个 Token 只绑定一台被控主机。** Token 泄露后，请在 Token 管理中删除或禁用旧 Token，再重新创建。

---

## 安装 Agent

在 Token 管理中点击对应 Token 的"安装命令"，复制面板生成的命令，在被控 Linux 主机上以 root 权限执行。

```bash
curl -fsSL http://你的面板地址:9810/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

如果面板使用 HTTPS 域名：

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

> **关于地址选择：** 如果系统设置里配置了面板公开域名，安装命令弹窗会默认使用公开域名。需要让 Agent 通过 IP + 端口直连时，可以先用 IP + 端口打开面板，再在弹窗里选择"当前访问地址"后复制命令。

安装完成后，进入**主机管理**，主机状态显示为绿色在线，说明 Agent 已正常连接面板。

### mimic UDP 混淆（可选）

安装脚本执行过程中会交互询问是否安装 mimic UDP 混淆环境：

```
是否安装 mimic UDP 混淆环境？[y/N]
```

- 默认选择 `n`，直接回车跳过，不影响正常转发功能。
- 输入 `Y` 才会进入 mimic 安装流程。
- 目标版本为 **mimic v0.7.1**；已安装旧版时会提示升级，已满足目标版本时直接复用。
- 对于不提供预编译二进制包的系统，脚本会询问是否从源码编译。

**mimic 说明：**

| 项目 | 内容 |
|------|------|
| 来源 | [hack3ric/mimic](https://github.com/hack3ric/mimic) |
| 版本 | v0.7.1 |
| 许可证 | GPL-2.0-only |
| 内核要求 | Linux 6.1+（XDP/TC eBPF） |

---

## 升级 Agent

可在面板**主机管理**中点击"升级"按钮，也可复制升级命令到服务器执行：

```bash
curl -fsSL http://你的面板地址:9810/api/agent/install.sh | bash -s -- upgrade YOUR_AGENT_TOKEN
```

> 如果面板地址变化导致 Agent 离线，重新执行带正确面板地址的安装或升级命令即可恢复连接。

---

## 卸载 Agent

卸载命令可在 Token 管理的安装命令弹窗中获取，通用卸载命令如下：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | bash -s -- uninstall
```

---

## 安装后文件位置

| 用途 | 路径 |
|------|------|
| Agent 通讯配置 | `/etc/forwardx/agent/config.json` |
| Agent 日志 | `/var/log/forwardx-agent/agent-go.log` |
| Agent 本地状态 | `/var/lib/forwardx-agent/` |
| ForwardX FXP 运行时（Go 实现） | `/usr/local/bin/forwardx-fxp` |
| GOST / 隧道运行时配置 | `/etc/forwardx/runtime/` |

**历史路径说明：** 旧版本留下的 `/etc/forwardx-agent`、`/etc/forwardx-runtime`、`/etc/forwardx-tunnel-runtime`、`/etc/forwardx-gost`、`/etc/forwardx-tunnels` 属于历史路径，升级时会优先迁移到 `/etc/forwardx` 下，后续不再新增这些分散目录。

---

## 常用运维命令

### 查看运行状态

```bash
systemctl status forwardx-agent
```

### 查看日志

```bash
tail -n 300 /var/log/forwardx-agent/agent-go.log
```

### 重启 Agent

```bash
systemctl restart forwardx-agent
```

### 查看配置

```bash
cat /etc/forwardx/agent/config.json
```

### 检查磁盘占用

Agent 会限制单个日志文件及 `/var/log/forwardx-agent` 的总占用。如发现磁盘异常增长，可用以下命令定位实际占用来源：

```bash
du -ak /var/log/forwardx-agent /var/lib/forwardx-agent 2>/dev/null | sort -n | tail -n 30
journalctl --disk-usage 2>/dev/null || true
du -sh /var/lib/systemd/coredump /var/crash 2>/dev/null || true
```

> **注意：** 环境变量 `FORWARDX_FXP_VERBOSE_LOG=1` 会记录每个 TCP/UDP 会话明细，仅应在短时间排障时启用，常规运行不建议开启。

---

## 常见问题

**Agent 安装后显示离线？**

- 检查面板地址是否正确，是否仍然是旧 IP。
- 如果面板已改为 HTTPS 域名，确认 Agent 配置也使用了 HTTPS 域名。
- 执行 `systemctl status forwardx-agent` 并查看日志，确认具体连接错误。
- 重新执行带正确面板地址的安装或升级命令，Agent 会自动更新配置并重连。
