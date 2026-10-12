# SSH 管理菜单（fwxm）

`fwxm` 是 ForwardX Manager 的四字母快捷命令，用于在 Linux SSH 终端管理面板和 Agent。它不是常驻服务，也不需要面板网页可访问。

## 打开菜单

使用 root 登录后直接执行：

```bash
fwxm
```

非 root 使用 `sudo fwxm`。只安装面板或 Agent 时进入对应菜单；两者同机安装时先选择管理对象。也可直接打开指定菜单：

```bash
fwxm panel
fwxm agent
```

菜单中的 **2）运行状态** 查看当前组件，**4）重启面板或 Agent** 重启所选组件；不是同时重启两者。其他选项包括关键信息、日志、代理、升级、重装修复与卸载；仅面板菜单显示管理员密码重置。输入 `0` 退出，查看持续日志时按 Ctrl+C 结束。

Docker 面板在**宿主机 SSH** 执行命令，不是在容器内。菜单选项执行完成后本次命令结束；再次输入 `fwxm` 即可重新打开。

## 命令速查

| 操作 | 面板 | Agent |
| --- | --- | --- |
| 打开菜单 | `fwxm panel` | `fwxm agent` |
| 运行状态 | `fwxm panel status` | `fwxm agent status` |
| 重启 | `fwxm panel restart` | `fwxm agent restart` |
| 启动 / 停止 | `fwxm panel start` / `stop` | `fwxm agent start` / `stop` |
| 跟随日志 | `fwxm panel logs` | `fwxm agent logs` |
| 配置路径、服务与地址 | `fwxm panel info` | `fwxm agent info` |
| 后台地址提示 | `fwxm panel address` | — |
| 查看 / 设置 / 关闭代理 | `fwxm panel proxy show` / `set` / `off` | `fwxm agent proxy show` / `set` / `off` |
| 升级 | `fwxm panel upgrade` | `fwxm agent upgrade` |
| 保留配置重装修复 | `fwxm panel repair` | `fwxm agent repair` |
| 卸载 | `fwxm panel uninstall` | `fwxm agent uninstall` |
| 重置管理员密码 | `fwxm panel reset-admin` | — |

表中的 `/ stop` 等表示分别执行完整命令，例如 `fwxm panel stop`，不要把斜杠一并输入。重置密码需要数据库可用，详见 [账号恢复](./account-recovery.md)。

## 安装与适用范围

包含该功能的新版官方安装器会在安装/升级完成后注册 `/usr/local/bin/fwxm`，并将受保护的辅助脚本、缓存安装器和面板元数据保存到 `/etc/forwardx/manage`。自定义的部署目录、服务名、容器名和 Compose 项目名会记录在此，日后不必每次重复输入。

如果提示 `command not found`：

1. 确认安装器/发布包包含本功能，且安装日志出现 `SSH management: fwxm`。
2. 检查 `/usr/local/bin/fwxm` 是否存在，以及 `/usr/local/bin` 是否在 PATH；可用 `sudo /usr/local/bin/fwxm` 验证。
3. 官方脚本部署按 [原部署方式升级](./upgrade-backup.md)；旧版不会仅因修改配置而自动生成命令。
4. 手工 Compose / 手工服务部署不保证自动注册管理元数据，应继续使用原生管理流程，不要为注册菜单而盲目套用默认目录安装器。

同一宿主机的元数据记录一套面板，支持同时管理一个 Agent；它不是多套面板实例的选择器。卸载后小型管理工具和缓存脚本会保留，方便排障或重新安装，不会运行后台进程。

## 操作边界

- `status` 显示本地服务管理器状态或 Docker 容器状态，不等于业务链路、数据库与所有转发目标均健康。
- `panel restart` 不升级镜像，也不会让 Docker 重新读取修改后的 Compose 环境；环境变更见 [环境变量](./env-vars.md)。
- `agent restart` 仅请求重启 Agent，不主动重启独立转发进程，但不能据此保证所有异常或升级场景连接不断。
- `repair` 重新下载安装当前可用版本并重启，保留数据/配置，**可能升级版本**；不是数据库恢复工具，也不是安装固定旧版本。
- 卸载 Agent 会停止受管转发。Docker 面板卸载确认后删除对应数据卷；本地卸载单独询问是否删除目录。先读 [卸载与数据保留](./uninstall.md)。
- 面板代理只影响维护下载，不代理 Node 运行通信或 Docker daemon 镜像拉取；Agent 代理不代理业务转发。详见 [代理配置](./agent-proxy-manager.md) / [English guide](./agent-proxy-manager.en.md)。
- 地址输出是端口、宿主机 IP 与映射提示，HTTPS 域名以反向代理和面板公开地址配置为准，不保证自动发现公网入口。
