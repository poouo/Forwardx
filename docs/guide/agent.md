# 安装与维护 Agent

Agent 安装在被管理的 Linux 主机上，执行转发配置、上报状态和流量、完成网络测试。实际转发由 Agent 与对应运行时完成，不是由面板服务器中转。

## 1. 创建独立 Token

进入「主机管理 → Token 管理」，创建 Token，再复制对应的安装命令。

**每个 Token 只绑定一台主机**。多台主机分别创建，不影响加入同一转发组、入口组或出口组。Token 泄露后应吊销并重新创建，不能公开截图或发送完整配置。

换机可使用原 Token 重新安装，沿用主机和规则。复制已关联 Token 的安装命令时需确认接管；无论旧机是否在线，新安装实例注册成功后接管管理并重新同步规则。支持接管的旧 Agent 收到通知后停止面板通讯，保留已有转发；旧版本请先升级或手动停止 Agent 服务。普通升级和服务重启保留安装身份，不会重新夺回已被接管的 Token；需要再次接管时重新执行安装命令。

接管不会自动迁移服务商的 NAT 映射、防火墙或用户填写的入口地址、内网地址和网卡配置，换机后请确认这些配置仍适用于新机器。

![创建 Token 并获取 Agent 安装命令](./images/agent-token-management.png)

## 2. 安装并确认在线

在被管理主机以 root 执行面板生成的命令，例如：

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

替换实际面板地址和 Token。安装命令默认采用配置的公开地址；需要其他可达入口时，在安装命令弹窗核对地址来源。安装后在主机列表确认在线及环境检测结果。

前置要求：Linux、root、可访问面板，以及到下载源/系统软件源的网络。Agent 不支持将 Windows 作为被控运行环境。安装器会检测架构并安装相应资产；不要把不支持的系统或 libc 强行套用其他二进制。

安装器默认选择兼容的 Realm `2.9.4`，其他版本可通过 `FORWARDX_REALM_VERSION` 显式选择。iperf3 仅用于网络测试，安装失败会警告，不应阻断 Agent 主流程。

## 2.1. 按主机使用不同的面板入口

管理员在「主机管理 → 编辑主机 → 其他配置」打开 **Agent 面板连接地址**，填写例如 `https://cn-panel.example.com:8443`。默认关闭，继续使用全局 `panelPublicUrl`；关闭后保留填写的地址，方便下次启用。启用时必须填写完整的 HTTP/HTTPS 地址，可带自定义端口，不支持账号密码、查询参数或片段。

此地址仅覆盖该主机的 Agent 通信和已绑定 Token 的安装、升级、回滚命令，不改变浏览器访问地址、业务转发地址或其他主机配置。现有 Agent 收到下次心跳响应后更新本地 `panelUrl`；配套新版 Agent 还会主动重连事件流，不重启业务转发。已离线的 Agent 需要先恢复与面板的通信才能接收配置。

反向代理由管理员自行配置，必须指向**同一面板**，完整转发 Agent API、流式 SSE 连接和认证头，并使用有效的 TLS 证书。不要填入不可信的第三方地址。该功能不会自动配置 CDN、反向代理或修复网络。

若填错地址导致离线，先修正面板内该主机的配置，再通过 SSH 修改 `/etc/forwardx/agent/config.json` 中的 `panelUrl` 为可达入口并执行 `systemctl restart forwardx-agent`。只在本地修改、却不修正面板设置，会在下次通信时再次被覆盖。进行面板迁移时，需要同步调整自建反向代理的后端；迁移流程的显式切换指令仍优先于普通配置。

English: In **Hosts → Edit → Other settings**, enable **Agent panel URL** to use a per-host reverse-proxy URL, including custom ports. Off uses the global URL and retains the saved value. The URL must lead to the same panel and forward Agent APIs, authentication headers and SSE correctly, with valid TLS. Installation for bound tokens, communication, upgrades and rollback use this URL. Existing Agents adopt it on the next heartbeat; the updated Agent also reconnects SSE without restarting forwarding. Offline Agents must regain connectivity first. If the URL is wrong, correct it in the panel, fix `panelUrl` in `/etc/forwardx/agent/config.json`, and restart `forwardx-agent` over SSH. This is not a local URL lock or an automatic reverse-proxy setup.

## 3. SOCKS / HTTP 代理（可选）

需要使用代理时，下载入口脚本与安装执行均需设置：

```bash
curl --proxy 'socks5h://127.0.0.1:1080' -fsSL \
  https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh \
  -o /tmp/forwardx-install-agent.sh

PANEL_URL='https://panel.example.com' bash /tmp/forwardx-install-agent.sh \
  install YOUR_AGENT_TOKEN --proxy 'socks5h://127.0.0.1:1080'
```

新版 Agent 的运行配置为 `/etc/forwardx/agent/config.json` 中的 `proxyUrl`。代理覆盖注册、心跳、上报、事件流与下载/升级，**不代理业务转发和 ping/tcping/iperf**。

已有新版 Agent 可添加该字段并重启；清空或删除后重启即直连，不继承系统代理环境变量。旧版 Agent 必须先升级。认证、远端 DNS、包管理器限制和完整方法见 [代理专题](./agent-proxy-manager.md)。

## 4. 使用 SSH 菜单

包含此功能的新版安装器会注册 `fwxm`。直接输入打开菜单：

```bash
fwxm
```

同机有面板时先选择 Agent；也可执行 `fwxm agent`。非 root 使用 `sudo fwxm`。菜单可查看运行状态、日志、重启、代理、升级和重装修复，详见 [SSH 管理](./ssh-management.md)。

```bash
fwxm agent status
fwxm agent logs
fwxm agent restart
fwxm agent info
fwxm agent proxy show
fwxm agent proxy set
fwxm agent proxy off
```

`proxy set` 支持隐藏输入，`set/off` 保存后重启 Agent。信息/代理查看会隐藏凭据，不建议用 `cat config.json` 向他人提供排障数据。

旧部署没有管理命令时可用原生命令：

```bash
systemctl status forwardx-agent --no-pager -l
tail -n 300 /var/log/forwardx-agent/agent-go.log
systemctl restart forwardx-agent
```

非 systemd 主机用 OpenRC / SysV 对应服务命令。

## 5. 升级与修复

可在主机管理页面选择单台或批量升级，也可在该 Agent 主机执行：

```bash
fwxm agent upgrade
```

升级复用 Token 和配置代理，无需再次填写凭据。旧版可从当前可达面板下载升级入口：

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- upgrade
```

已有代理时优先使用 `fwxm`；直接运行上面的下载命令时，前面的 curl 也必须单独设置代理。面板地址变化、离线时请明确指定正确入口，不要指望只修改面板公开地址就能通知失联主机。

`fwxm agent repair` 保留配置，重新下载安装当前可用版本并重启，可能升级版本，不等同于只重启。升级或修复运行时不保证业务连接不断；跨面板迁移请用 [迁移流程](./migration.md)，不要先卸载。

## 6. 卸载

```bash
fwxm agent uninstall
```

需要交互确认，会停止受管转发。管理命令调用缓存入口执行本地清理，不要求面板在线；旧版可先下载 GitHub 入口脚本，再运行 `uninstall`。详见 [卸载与数据保留](./uninstall.md)。

## 文件与日志

| 用途 | 默认路径 |
| --- | --- |
| 通信、Token 和代理配置 | `/etc/forwardx/agent/config.json` |
| Agent 程序 | `/usr/local/bin/forwardx-agent` |
| FXP / GOST 运行时 | `/usr/local/bin/forwardx-fxp` / `/usr/local/bin/forwardx-runtime` |
| 常规日志 | `/var/log/forwardx-agent/agent-go.log` |
| 自升级安装日志 | `/var/log/forwardx-agent/agent-upgrade.log` |
| 持久化状态 | `/var/lib/forwardx-agent/` |
| 临时运行态 | `/run/forwardx-agent/` |
| GOST 配置 | `/etc/forwardx/runtime/` |
| SSH 管理辅助脚本 | `/etc/forwardx/manage/` |

历史路径 `/etc/forwardx-agent`、`/etc/forwardx-runtime`、`/etc/forwardx-tunnel-runtime`、`/etc/forwardx-gost`、`/etc/forwardx-tunnels` 可能存在，升级会处理相应迁移。不要手动清空整个 `/etc/forwardx`；同机可能还有面板管理配置。

### ForwardX 自编译转发运行时

后续发行包中的 `forwardx-runtime` 由维护者在本机从固定的 GOST 3.2.6 源码提交编译，上传到独立的运行时 Release。当前源码固定为 `runtime-v3.2.6-forwardx.2`，需先发布该运行时附件，再发布依赖它的面板或 Agent 安装包。面板、Docker 和 Agent 发布包统一下载这批产物并校验固定 SHA-256，不再各自重新编译或分发上游预编译二进制。程序名和 `-V` 输出使用 ForwardX 标识，引擎类型、配置路径、协议及管理 API 保持兼容，不需要修改已有规则。

该运行时修复 GOST 节点选择器的主备切换：仍有正常候选时，不因隔离时间到期就重试已知故障节点，避免周期性卡顿；不会主动抢回原首选节点。全部节点均失败时才轮流尝试恢复，首次故障和全部故障时仍可能有连接等待。此行为不改变面板转发组的 DDNS 故障窗口、恢复窗口或「恢复后切回」设置，也不改变 Agent 本地目标主备代理的健康检测。

新安装和升级只从 ForwardX Release 或面板获取这一构建；不会复制机器上已有的 `gost`，也不会在失败时静默下载上游原版。若新包不可用，保留已有运行时并明确警告，避免下载失败破坏现有转发；因此已有节点需在自编译资产发布后执行 Agent 升级，不能仅更新面板就认为节点已替换。替换二进制后仍需按维护计划重启运行时或重新应用规则，才能让现有进程使用新构建，可能短暂中断连接。

可用 `/usr/local/bin/forwardx-runtime -V` 检查当前磁盘文件。Release 和面板运行包的 `dist/agent/` 提供 `RUNTIME_BUILD.txt`（源码提交、源码 SHA-256、Go 版本与产物哈希）和 `RUNTIME_LICENSE.txt`，完整声明见仓库 `THIRD_PARTY_NOTICES.md`。维护者可运行 `bash scripts/build-runtime.sh` 构建 Linux amd64/arm64，也可指定 `amd64` 或 `arm64`；需要 Go 1.24+、curl、tar 和 coreutils，Agent 机器无需安装 Go。

维护发布时先本机编译，再上传两种架构的产物、构建信息和许可证；更新 `shared/runtimeBuild.ts` 的版本、独立 Release 标签和四项产物哈希后再发布面板。已发布运行时不覆盖替换，重新构建产生不同哈希时须递增运行时版本。`bash scripts/fetch-runtime.sh` 可验证发布下载路径，校验失败会中止打包并保留旧文件。

源码构建使用稳定版本标识，不添加随机填充；同一源码和构建环境允许重复得到相同产物。构建会校验其 MD5 不等于已核验的对应上游 Linux 3.2.6 发行文件，完整性验证使用 SHA-256。自编译和更名**不保证安全软件不再告警**；若仍被归为代理风险工具，应核验哈希、来源和实际行为后向厂商申诉，不要关闭整个安全防护。

日志有大小限制，详细会话日志仅用于短时排障。Agent 离线时先核对面板 URL、代理连通性、证书及日志；安装失败看第一个真实错误，升级失败还要看 `agent-upgrade.log`。目录、日志与资源排障见 [运维目录](./paths-logs.md) 和 [常见问题](./troubleshooting.md)。

## mimic UDP 混淆（可选）

仅显式启用 ForwardX 隧道混淆时需要；普通转发不依赖 mimic。安装器默认询问，回车跳过，输入 Y 才安装。当前目标 `mimic v0.7.1`，需要 Linux 6.1+ 与相应 XDP/TC 内核能力。

缺少依赖时面板会阻止启用并提供安装提示；Agent 不会因运行中的混淆开关自动安装内核组件。详见 [部署准备](./preparation.md) 和 [隧道](./tunnels.md)。
