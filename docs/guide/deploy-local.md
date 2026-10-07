# 本地部署

不使用 Docker，在 Linux 宿主机运行正式发布包。安装脚本负责运行环境、发布包、数据目录和服务配置；优先使用此方式。

## 一键安装

使用 root 执行；非 root 将管道后的 bash 替换为 sudo bash。

~~~bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- install --language zh-CN
~~~

脚本使用 Node.js 22 或更高版本、pnpm，下载 GitHub Release 中的面板包并安装生产依赖。按提示选择访问端口和数据库，再在网页完成初始化。

英文向导用 --language en，自动检测用 --language auto。生产环境必须保持 NODE_ENV=production，不能开启开发自动登录。

## 默认目录与服务

| 项目 | 位置 |
| --- | --- |
| 安装目录 | /opt/forwardx-panel |
| 启动环境 | /opt/forwardx-panel/.env |
| 程序入口 | /opt/forwardx-panel/dist/index.js |
| 数据目录 | /opt/forwardx-panel/data |
| 数据库配置 | /opt/forwardx-panel/data/database.json |
| SQLite 文件 | /opt/forwardx-panel/data/forwardx.db |
| systemd 服务 | forwardx-panel.service |

安装器的 FORWARDX_PANEL_DIR / FORWARDX_SERVICE_NAME 可改变目录和服务名。以下命令按默认 systemd 安装演示；OpenRC / SysV 环境使用对应服务管理命令，非 systemd 的控制台日志通常位于安装目录 data/panel.log。

## 检查和重启

~~~bash
systemctl status forwardx-panel --no-pager -l
journalctl -u forwardx-panel -n 300 --no-pager
~~~

修改 .env 后重启：

~~~bash
sudo systemctl restart forwardx-panel
~~~

仅修改 .env 不需要 daemon-reload；修改 systemd 单元文件后才需要先执行 systemctl daemon-reload。日志文件目录的选择规则见 [目录与日志](./paths-logs.md)。

## 升级

~~~bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade
~~~

脚本下载并安装发布包，保留 data 中的数据库和业务配置。它会重写 .env 并保留所识别的核心项，不保证保留所有手动新增环境变量；升级前备份并核对自定义项。

指定版本、加速、备份与兼容迁移见 [升级与备份](./upgrade-backup.md)。普通升级会重启面板，不能等同于 [无缝面板迁移](./migration.md)。

## 手动维护发布包

如果确实需要自行维护服务，在 [GitHub Releases](https://github.com/poouo/Forwardx/releases) 下载目标版本的 forwardx-panel-v版本.tar.gz，不要将源码压缩包当成生产包。

发布包包含 dist、client/dist、drizzle、patches、package.json、pnpm 锁文件和安装/迁移脚本。自行维护时需要：

1. 准备 Node.js 22+ 与与安装器/CI 一致的 pnpm 版本（当前为 10.28.1）。
2. 将发布包先下载并解压到独立暂存目录，确认文件完整后再安排切换；不要先删除运行中的 dist。
3. 按锁文件安装生产依赖，保留 patches，并按 pnpm 的构建审批机制处理必要的原生依赖。
4. 配置 NODE_ENV、PORT、固定随机 JWT_SECRET，以及数据库配置与数据文件的**绝对路径**。可参考 [环境变量](./env-vars.md)。
5. 通过服务管理器设置正确的工作目录、环境文件和 node dist/index.js 启动命令，不使用 pnpm dev。
6. 升级前备份数据库、环境文件与证书；切换时停止旧面板实例，验证新实例正常后再处理旧程序文件。

自动安装器已实现上述部署流程。自行维护的部署不要直接套用安装器升级，以免覆盖自定义服务或配置；数据库已被新版升级后，也不能只换回旧程序就认定回退安全。

## 下一步

访问 http://服务器IP:9810（以配置端口为准），完成 [首次初始化](./first-setup.md)，再配置 [HTTPS 与反向代理](./reverse-proxy.md)。
