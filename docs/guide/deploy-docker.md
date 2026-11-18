# Docker 部署

支持一键安装与手动 Compose 两种方式。默认容器名为 forwardx-panel，Compose 服务名为 forwardx，宿主机端口 9810 映射到容器端口 3000。

## 一键安装（推荐）

使用 root 执行；非 root 将管道后的 bash 替换为 sudo bash。

~~~bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install --language zh-CN
~~~

安装时按提示选择访问端口和数据库。SQLite 无需额外数据库服务；MySQL/PostgreSQL 需要准备可访问的数据库和账号。脚本可能预填数据库配置，网页仍需确认连接并完成初始化。

JWT 签名密钥无需手动填写：一键安装使用安全随机源生成独立的 256 位密钥（64 位十六进制字符串），保存到仅所有者可读写的 `.env`，升级保留原值。随机源失败时安装会停止，不使用固定值或时间戳代替。

访问 http://服务器IP:9810（端口以安装时选择为准）。英文向导使用 --language en；跟随浏览器语言使用 --language auto，网页可手动切换。

脚本会选择并校验发布镜像；默认镜像仓库为 ghcr.io/poouo/forwardx。新版本镜像尚未构建完成时不要强行替换正在运行的容器。

### 官方脚本的时间同步

官方一键脚本在宿主机阶段会自动处理时间同步：优先复用并启动已有的 `systemd-timesyncd` 或 `chrony`，都不存在时按当前发行版安装 `chrony`，然后尝试立即校时。时间同步服务启动失败只会输出警告，不会阻止面板安装；面板自身仍会使用 HTTPS 时间源校准旧版 Agent 协议时间。

这项处理只属于官方 `install-panel-docker.sh` 的宿主机安装流程。手动 Compose、直接 `docker run`、第三方面板管理器或已有自定义部署不会安装或修改宿主机时间服务。Docker 容器与宿主机共享时钟，不能通过容器内部单独校时；自行部署时请在宿主机配置 NTP/chrony，也不要为了校时给面板容器增加 `privileged` 或 `SYS_TIME` 权限。

## 数据与配置

| 项目 | 默认位置 |
| --- | --- |
| 宿主机部署目录 | /opt/forwardx-docker |
| Compose 与环境配置 | docker-compose.yml、.env（位于部署目录） |
| 容器程序 | /app |
| 容器持久化数据 | /data |
| 默认命名卷 | forwardx_forwardx-data |
| 数据库连接配置 | /data/database.json |
| SQLite 文件 | /data/forwardx.db |

卷名随 Compose 项目名变化。通过以下命令确认实际挂载，不要凭目录名判断数据是否存在：

~~~bash
docker inspect forwardx-panel --format '{{range .Mounts}}{{println .Type .Name .Source .Destination}}{{end}}'
~~~

安装脚本生成的 Compose 使用显式命名的外部卷；仓库根目录的 Compose 使用普通命名卷。都应持久化 /data，但删除方式不同。不要随意更换项目名、卷名或使用 down -v。

## 日常管理

新版官方安装/升级后，在**宿主机 SSH** 直接输入 `fwxm` 打开交互菜单；同机装有 Agent 时先选择面板。常用命令：

~~~bash
fwxm panel status
fwxm panel restart
fwxm panel logs
fwxm panel address
fwxm panel reset-admin
~~~

详见 [SSH 管理菜单](./ssh-management.md)。旧版或手工部署未注册该命令时，使用原生 Docker 命令：

~~~bash
docker ps --filter name=forwardx-panel
docker logs --tail 300 forwardx-panel
docker restart forwardx-panel
~~~

上面的 restart 只重启已有容器，**不会重新读取修改后的 Compose 环境变量**。修改环境配置后需要重建容器，详见 [环境变量](./env-vars.md)。

脚本管理的部署使用脚本升级：

已有新版管理命令时可使用 `fwxm panel upgrade`；否则执行下方入口脚本。

~~~bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade
~~~

升级会保留数据卷和脚本识别的核心配置，但脚本会重新生成 Compose 和 .env，**不会原样保留所有手动追加的内容**。升级前备份配置并核对自定义挂载、网络和环境变量。完整流程见 [升级与备份](./upgrade-backup.md)。

## 手动 Compose 部署

适合已经安装 Docker Engine 与 Compose 插件、能够自行维护配置的用户。使用独立目录，避免与安装脚本管理的目录混用。

手动部署不会执行官方安装脚本的时间同步步骤。请先确认宿主机的 `systemd-timesyncd` 或 `chrony` 正常运行；容器内的 `TZ` 只影响显示时区，不能修正宿主机时钟。

~~~bash
sudo mkdir -p /opt/forwardx-compose
cd /opt/forwardx-compose
sudo curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/docker-compose.yml -o docker-compose.yml
~~~

用编辑器创建 .env，填写下列配置。JWT_SECRET 留空即可在首次启动时安全生成，并持久保存到数据卷 `/data/jwt.secret`；务必保留该数据卷。也可自行使用 `openssl rand -hex 32` 生成密钥并填写，不要使用固定示例值：

~~~ini
COMPOSE_PROJECT_NAME=forwardx
FORWARDX_CONTAINER_NAME=forwardx-panel
FORWARDX_IMAGE=ghcr.io/poouo/forwardx:latest
PORT=9810
FORWARDX_SETUP_LANGUAGE=zh-CN
JWT_SECRET=
~~~

建议生产环境将 FORWARDX_IMAGE 固定为已发布且构建完成的版本标签。使用 main 分支 Compose 时先核对它与所选镜像支持的配置是否一致。保护 .env 的读取权限。

~~~bash
sudo chmod 600 .env
sudo docker compose up -d forwardx
sudo docker compose logs --tail 300 forwardx
~~~

默认只有面板服务，不包含 MySQL/PostgreSQL 容器；可以在网页配置外部数据库。数据库地址见 [数据库配置](./database.md)。

手动部署继续用手动升级流程，在原目录执行：

~~~bash
sudo docker compose pull forwardx
sudo docker compose up -d forwardx
sudo docker compose logs --tail 300 forwardx
~~~

先备份；固定版本标签时需先修改镜像标签。不要通过卸载、删除卷或清空程序目录来升级。手动模式不会自动启用宿主机上的安装脚本升级命令。

## GitHub 下载加速

下面是格式示例，mirror.example.com 必须替换为你信任且实际可用的加速站：

~~~bash
curl -fsSL "https://mirror.example.com/https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh" \
  | bash -s -- install --language zh-CN --github-accelerator "https://mirror.example.com"
~~~

脚本保存加速地址，后续升级可复用。该参数仅代理 GitHub 下载，不代理 ghcr.io；镜像源使用 FORWARDX_IMAGE / FORWARDX_IMAGE_REPO 单独配置。

## 下一步

完成 [首次初始化](./first-setup.md)，配置 [HTTPS](./reverse-proxy.md)。需要找文件、查看日志或恢复管理员时，分别参考 [目录与日志](./paths-logs.md)、[账号恢复](./account-recovery.md)。

卸载脚本经确认后会删除容器、数据卷和部署目录；不是“停止服务”的替代命令。操作前阅读 [卸载说明](./uninstall.md)。
