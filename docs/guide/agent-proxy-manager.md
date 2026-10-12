# Agent 代理与 SSH 管理

[English](./agent-proxy-manager.en.md)

本功能需要包含该功能的新版面板安装器和 Agent。安装或升级后，SSH 中使用 `fwxm`（ForwardX Manager，四个字母）打开管理菜单。既支持本地面板，也支持 Docker 面板；Docker 面板的命令安装在**宿主机**，无需进入容器。

## 通过 SOCKS 安装 Agent

推荐 `socks5h://`，域名交给代理解析；`socks5://` 也会统一为此行为。支持用户名密码，以及 HTTP / HTTPS 代理。

先在面板创建主机并取得独立 Token。以下命令在被管理服务器以 root 执行，替换代理、面板地址和 Token：

```bash
curl --proxy 'socks5h://127.0.0.1:1080' -fsSL \
  https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh \
  -o /tmp/forwardx-install-agent.sh

PANEL_URL='https://panel.example.com' bash /tmp/forwardx-install-agent.sh \
  install YOUR_TOKEN --proxy 'socks5h://127.0.0.1:1080'
```

两处代理都要指定：第一处用于下载入口脚本，`--proxy` 安装参数用于后续下载、注册、Agent 运行及升级。也可以下载面板的 `/api/agent/install.sh` 后使用同样参数。不要只给 `bash` 传代理，却让前面的 `curl` 直连。

带认证示例：`socks5h://username:password@proxy.example.com:1080`。用户名和密码中的特殊字符需要 URL 编码，如 `@` → `%40`。必须写端口。命令行可能留在 shell 历史或进程列表中，含密码时优先使用下述隐藏输入。配置文件包含凭据，应保持 root 可读（`chmod 600`），不要发送给他人。

代理覆盖 Agent 心跳、注册、流量上报、事件流和安装/升级下载；**不代理业务转发、隧道数据、主机公网 IP 发现、ping/tcping/iperf 测试**。代理必须允许长连接访问面板。代理失效会导致 Agent 离线/升级失败，不会自动改成直连。

系统包安装仍取决于发行版的包管理器。推荐现代 Debian/Ubuntu APT 或使用 libcurl 的包管理器。Alpine APK 不保证支持 SOCKS：请先备齐系统依赖，或使用 HTTP 代理；不要把 SOCKS 下载支持理解为所有包管理器都支持 SOCKS。

## 已有 Agent / 切回直连

新版 Agent 的配置文件为 `/etc/forwardx/agent/config.json`。保留原来的 `panelUrl`、`token` 以及其他字段，只增改 `proxyUrl`：

```json
{
  "panelUrl": "https://panel.example.com",
  "token": "KEEP_YOUR_EXISTING_TOKEN",
  "interval": 30,
  "proxyUrl": "socks5h://127.0.0.1:1080"
}
```

修改后执行 `systemctl restart forwardx-agent`；非 systemd 主机使用对应服务管理器。删除 `proxyUrl` 字段或改为 `"proxyUrl": ""` 再重启即直连，不会继承 `HTTP_PROXY` / `ALL_PROXY`。旧版 Agent 不识别此字段，必须先升级。

有管理命令时更方便：

```bash
fwxm agent proxy show       # 隐藏用户名密码
fwxm agent proxy set        # 隐藏输入代理 URL；保存后重启 Agent
fwxm agent proxy off        # 保存为直连，并重启 Agent
fwxm agent upgrade          # 沿用当前配置中的代理
```

设置代理只重启 Agent，不主动重启独立转发进程；无法承诺升级或重装过程中业务完全不断。手动升级脚本可用 `upgrade --proxy URL` 更改代理，或 `upgrade --no-proxy` 保存为直连。面板触发的自动升级也读取受保护配置，不依赖 systemd 继承环境变量。

## SSH 快捷命令

菜单打开方式、**2）运行状态**、**4）重启面板或 Agent**、旧版未注册命令的排查见 [SSH 管理菜单](./ssh-management.md)。本页保留代理相关速查，供旧链接继续访问。

执行 `fwxm` 使用交互菜单，或使用命令：

| 命令 | 用途 |
| --- | --- |
| `fwxm agent info` / `fwxm panel info` | 配置路径、服务、代理及地址，不输出 Token/数据库密码 |
| `fwxm agent status` / `fwxm panel status` | 查看服务状态 |
| `fwxm agent logs` / `fwxm panel logs` | 跟随日志，Ctrl+C 退出 |
| `fwxm agent start\|stop\|restart` | 启停 Agent |
| `fwxm panel start\|stop\|restart` | 启停本地服务或 Docker 容器 |
| `fwxm agent upgrade` / `fwxm panel upgrade` | 升级 |
| `fwxm agent repair` / `fwxm panel repair` | 保留配置/数据，重新下载安装当前可用新版并重启，不保证版本不变 |
| `fwxm agent uninstall` / `fwxm panel uninstall` | 卸载并确认；Docker 删除对应卷，本地可选择保留目录 |
| `fwxm panel reset-admin` | 交互重置管理员密码，支持本地与 Docker |
| `fwxm panel address` | 查看端口、宿主机地址提示和 Docker 映射，域名以反代配置为准 |
| `fwxm panel proxy show\|set\|off` | 面板维护下载代理，不修改 Node 运行时代理 |

同机安装 Agent 和面板时通过 `agent` / `panel` 明确操作对象。修复、卸载会影响服务，请在维护时操作。卸载后保留小型管理工具及缓存安装器，便于重新安装；它们不运行后台服务。直接使用 `install` 命令时，已存在的安装按升级处理以保留注册和数据。

面板维护代理只用于支持代理环境变量的下载工具，不能保证 npm/系统包工具都支持 SOCKS。**Docker 镜像拉取由 Docker daemon 完成**，必须按 Docker 官方方法单独配置 daemon 的 HTTP/HTTPS 代理（纯 SOCKS 需代理软件提供 HTTP 入口）；`fwxm` 不修改宿主机全局 Docker 配置。面板 TG/Discord/OAuth 等运行时网络也不由此代理。

自定义部署目录、服务名、容器名和 Compose 项目名由安装器记录，管理命令沿用这些参数。手工 Compose 部署或旧版本若没有 `fwxm`，请先用对应官方面板安装器升级，不要对未知容器直接运行默认安装命令。
