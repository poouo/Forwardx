# 部署面板

ForwardX 面板支持 Docker 部署和本地 systemd 部署。普通用户优先推荐 Docker 部署；如果你希望面板直接运行在宿主机上，可以选择本地 systemd 部署。

## Docker 一键部署

以 root 用户执行：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install
```

安装完成后访问：

```text
http://服务器IP:9810
```

第一次打开面板时不会直接进入后台，而是进入初始化向导。你需要先选择数据库，再创建管理员账号。

Docker 部署的特点：

- 安装简单。
- 升级方便。
- 数据保存在 Docker 数据卷中。
- 默认使用官方镜像，不需要在服务器上编译项目。

常用命令：

```bash
# 升级面板
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade

# 卸载面板
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- uninstall

# 查看容器日志
docker logs -n 300 forwardx-panel
```

默认部署目录通常是：

```text
/opt/forwardx-docker
```

如需卸载 Docker 面板，请先阅读 [卸载 ForwardX](./uninstall.md)，确认是否保留数据卷和数据库。

## Docker 手动部署

如果你不想使用一键脚本，也可以手动创建 Docker Compose。下面以 `/opt/forwardx-docker` 为例。

### 1. 安装 Docker

Ubuntu/Debian 常用安装方式：

```bash
curl -fsSL https://get.docker.com | bash
systemctl enable --now docker
docker compose version
```

如果 `docker compose version` 能输出版本号，就可以继续。

### 2. 创建部署目录

```bash
mkdir -p /opt/forwardx-docker
cd /opt/forwardx-docker
```

### 3. 写入 `.env`

先生成一个随机登录密钥：

```bash
openssl rand -hex 32
```

然后创建 `.env`：

```bash
cat > .env <<'EOF'
PORT=9810
COMPOSE_PROJECT_NAME=forwardx
FORWARDX_CONTAINER_NAME=forwardx-panel
FORWARDX_IMAGE=ghcr.io/poouo/forwardx:latest
JWT_SECRET=请替换为上一步生成的随机字符串

# 可选：如果要通过环境变量指定 PostgreSQL，取消注释并填写
# DATABASE_TYPE=postgresql
# POSTGRES_HOST=host.docker.internal
# POSTGRES_PORT=5432
# POSTGRES_USER=forwardx
# POSTGRES_PASSWORD=请填写数据库密码
# POSTGRES_DATABASE=forwardx
# POSTGRES_SSL=false

# 可选：如果要通过环境变量指定 MySQL，取消注释并填写
# DATABASE_TYPE=mysql
# MYSQL_HOST=host.docker.internal
# MYSQL_PORT=3306
# MYSQL_USER=forwardx
# MYSQL_PASSWORD=请填写数据库密码
# MYSQL_DATABASE=forwardx
# MYSQL_SSL=false
EOF
```

不确定数据库怎么选时，先不要填写 MySQL/PostgreSQL 变量，首次打开面板时选择 SQLite 即可。

### 4. 写入 `docker-compose.yml`

```bash
cat > docker-compose.yml <<'EOF'
name: ${COMPOSE_PROJECT_NAME:-forwardx}

services:
  forwardx:
    image: ${FORWARDX_IMAGE:-ghcr.io/poouo/forwardx:latest}
    container_name: ${FORWARDX_CONTAINER_NAME:-forwardx-panel}
    restart: unless-stopped
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "${PORT:-9810}:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      JWT_SECRET: ${JWT_SECRET}
      DATABASE_CONFIG_PATH: /data/database.json
      SQLITE_PATH: /data/forwardx.db
      MYSQL_CONFIG_PATH: /data/mysql.json
      DATABASE_TYPE: ${DATABASE_TYPE:-}
      MYSQL_URL: ${MYSQL_URL:-}
      MYSQL_HOST: ${MYSQL_HOST:-}
      MYSQL_PORT: ${MYSQL_PORT:-3306}
      MYSQL_USER: ${MYSQL_USER:-}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD:-}
      MYSQL_DATABASE: ${MYSQL_DATABASE:-}
      MYSQL_SSL: ${MYSQL_SSL:-false}
      POSTGRES_URL: ${POSTGRES_URL:-}
      POSTGRES_HOST: ${POSTGRES_HOST:-}
      POSTGRES_PORT: ${POSTGRES_PORT:-5432}
      POSTGRES_USER: ${POSTGRES_USER:-}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-}
      POSTGRES_DATABASE: ${POSTGRES_DATABASE:-}
      POSTGRES_SSL: ${POSTGRES_SSL:-false}
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:-}
    volumes:
      - forwardx-data:/data

volumes:
  forwardx-data:
    driver: local
EOF
```

### 5. 启动面板

```bash
docker compose --env-file .env -p forwardx pull forwardx
docker compose --env-file .env -p forwardx up -d --remove-orphans forwardx
docker logs -n 100 forwardx-panel
```

浏览器访问：

```text
http://服务器IP:9810
```

### 6. 手动升级 Docker 面板

```bash
cd /opt/forwardx-docker
docker compose --env-file .env -p forwardx pull forwardx
docker compose --env-file .env -p forwardx up -d --remove-orphans forwardx
docker image prune -f
```

升级不会删除 `forwardx-data` 数据卷，也不会改动 `.env`。如果你手动执行 `docker volume rm`，数据才会被删除。

### 7. Docker 外部数据库地址怎么填

如果你在 Docker 或 1Panel 中使用 MySQL/PostgreSQL，数据库地址必须是“面板容器内部能访问到的地址”，不是你电脑浏览器能访问到的地址。

常见填写方式：

| 场景 | 数据库地址建议 |
| --- | --- |
| 数据库和面板在同一个 compose 项目网络 | 填数据库服务名，例如 `postgres`、`mysql` |
| 使用 1Panel 创建的数据库容器 | 填 1Panel 显示的数据库容器服务名，并确认面板容器和数据库容器在同一网络 |
| 数据库在宿主机上 | 填 `host.docker.internal` 或宿主机内网 IP，不建议填 `127.0.0.1` |
| 数据库在另一台服务器 | 填面板容器可访问的内网 IP、公网 IP 或域名 |

::: warning 注意
在面板容器里，`127.0.0.1` 指的是面板容器自己，不是宿主机，也不是数据库容器。日志里出现 `getaddrinfo ENOTFOUND xxx` 时，通常表示填写的数据库主机名在面板容器内无法解析。
:::

## 本地 systemd 一键部署

如果你不想使用 Docker，可以使用本地部署：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- install
```

安装完成后访问：

```text
http://服务器IP:9810
```

常用命令：

```bash
# 升级面板
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade

# 卸载面板
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- uninstall

# 查看面板日志
journalctl -u forwardx-panel -n 300 --no-pager
```

默认安装目录通常是：

```text
/opt/forwardx-panel
```

如需卸载本地面板，请先阅读 [卸载 ForwardX](./uninstall.md)，确认是否保留安装目录和数据库。

## 本地 systemd 手动部署

本地手动部署适合不使用 Docker、也不想执行一键脚本的用户。建议直接使用 GitHub Release 中的面板安装包，不建议普通用户在服务器上从源码编译。

### 1. 准备 Node.js 和 pnpm

ForwardX 面板需要 Node.js 22 或以上版本。

Ubuntu/Debian 示例：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs curl tar gzip
corepack enable
corepack prepare pnpm@10.28.1 --activate
node -v
pnpm -v
```

如果你使用 CentOS、AlmaLinux、Rocky Linux、Debian 旧版本或其他系统，只要最终 `node -v` 是 22 或以上，`pnpm -v` 能正常输出即可。

### 2. 下载面板安装包

把 `VERSION` 改成 GitHub Releases 中的最新版本号：

```bash
VERSION=v2.3.187
APP_DIR=/opt/forwardx-panel

mkdir -p "$APP_DIR"
curl -fL "https://github.com/poouo/Forwardx/releases/download/${VERSION}/forwardx-panel-${VERSION}.tar.gz" -o /tmp/forwardx-panel.tar.gz
tar -xzf /tmp/forwardx-panel.tar.gz -C "$APP_DIR"
cd "$APP_DIR"
pnpm install --prod --frozen-lockfile
```

如果下载时提示安装包不存在，通常是 GitHub Actions 还没有把该版本安装包上传完成，稍后重试即可。

### 3. 写入运行环境

先生成随机登录密钥：

```bash
openssl rand -hex 32
```

创建数据目录和 `.env`：

```bash
mkdir -p /opt/forwardx-panel/data
cat > /opt/forwardx-panel/.env <<'EOF'
NODE_ENV=production
PORT=9810
DATABASE_CONFIG_PATH=/opt/forwardx-panel/data/database.json
SQLITE_PATH=/opt/forwardx-panel/data/forwardx.db
MYSQL_CONFIG_PATH=/opt/forwardx-panel/data/mysql.json
JWT_SECRET=请替换为随机字符串
FORWARDX_PORT_CONFIG_PATH=/opt/forwardx-panel/.env
FORWARDX_PORT_MANAGEMENT=local
EOF
chmod 600 /opt/forwardx-panel/.env
```

不确定数据库怎么选时，不需要提前写数据库变量。首次进入面板时选择 SQLite 即可。

### 4. 创建 systemd 服务

```bash
cat > /etc/systemd/system/forwardx-panel.service <<'EOF'
[Unit]
Description=ForwardX Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/forwardx-panel
EnvironmentFile=/opt/forwardx-panel/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now forwardx-panel
journalctl -u forwardx-panel -n 100 --no-pager
```

浏览器访问：

```text
http://服务器IP:9810
```

### 5. 手动升级本地面板

升级前建议先备份 `/opt/forwardx-panel/data`。升级时保留 `data` 和 `.env`，只替换程序文件。

```bash
VERSION=v2.3.187
APP_DIR=/opt/forwardx-panel

systemctl stop forwardx-panel
cd "$APP_DIR"
rm -rf dist client drizzle scripts
rm -f package.json pnpm-lock.yaml pnpm-workspace.yaml
curl -fL "https://github.com/poouo/Forwardx/releases/download/${VERSION}/forwardx-panel-${VERSION}.tar.gz" -o /tmp/forwardx-panel.tar.gz
tar -xzf /tmp/forwardx-panel.tar.gz -C "$APP_DIR"
pnpm install --prod --frozen-lockfile
systemctl start forwardx-panel
journalctl -u forwardx-panel -n 100 --no-pager
```

::: warning 不要删除这些文件
本地部署升级时不要删除 `/opt/forwardx-panel/data` 和 `/opt/forwardx-panel/.env`。前者保存数据库和数据库连接配置，后者保存端口、登录密钥等运行环境。
:::

## 配置域名和 HTTPS

建议使用 Nginx、Caddy 或宝塔反向代理到面板端口。

Nginx 示例：

```nginx
server {
    listen 80;
    server_name panel.example.com;

    location / {
        proxy_pass http://127.0.0.1:9810;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

配置 HTTPS 后，面板公开地址建议填写：

```text
https://panel.example.com
```

::: warning 反向代理后一定要配置面板公开地址
如果用户通过 `https://panel.example.com` 访问面板，后台“系统设置 -> 系统信息”中的面板公开地址也应填写这个 HTTPS 地址。Agent 安装和通讯会使用该地址，后台留空或仍是 `http://服务器IP:端口` 时，后续面板 IP 变化或反代环境可能导致 Agent 离线。
:::

## 首次进入面板

部署完成后，浏览器打开面板地址会进入首次初始化页面。

初始化流程：

1. 选择数据库：SQLite、MySQL 或 PostgreSQL。
2. 如果选择 MySQL/PostgreSQL，填写地址、端口、数据库名、用户名、密码和 SSL 开关。
3. 点击保存连接，系统会先测试数据库是否能连接。
4. 创建第一个管理员账号。
5. 登录后台后，在系统设置里填写面板公开地址。

数据库选择建议：

| 数据库 | 适合情况 |
| --- | --- |
| SQLite | 第一次使用、单机、小规模规则，最省心 |
| MySQL | 长期使用、多用户、已有 MySQL 环境 |
| PostgreSQL | 已有 PostgreSQL 环境，或希望使用 PostgreSQL 管理数据 |

更多运行参数可以看 [环境变量](./env-vars.md)，更完整的初始化说明可以看 [首次初始化](./first-setup.md)。
