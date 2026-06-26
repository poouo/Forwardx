# 部署面板

ForwardX 面板支持 Docker 部署和本地 systemd 部署。普通用户优先推荐 Docker 部署。

## Docker 部署

以 root 用户执行：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install
```

安装完成后访问：

```text
http://服务器IP:3000
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

### Docker 外部数据库地址怎么填

如果你在 Docker 或 1Panel 中使用 MySQL/PostgreSQL，数据库地址必须是“面板容器内部能访问到的地址”，不是你电脑浏览器能访问到的地址。

常见填写方式：

| 场景 | 数据库地址建议 |
| --- | --- |
| 数据库和面板在同一个 compose 项目网络 | 填数据库服务名，例如 `postgres`、`mysql` |
| 使用 1Panel 创建的数据库容器 | 填 1Panel 显示的数据库容器服务名，并确认面板容器和数据库容器在同一网络 |
| 数据库在宿主机上 | Linux 通常填宿主机内网 IP，不建议填 `127.0.0.1` |
| 数据库在另一台服务器 | 填对方面板服务器可访问的内网 IP、公网 IP 或域名 |

::: warning 注意
在面板容器里，`127.0.0.1` 指的是面板容器自己，不是宿主机，也不是数据库容器。日志里出现 `getaddrinfo ENOTFOUND xxx` 时，通常表示填写的数据库主机名在面板容器内无法解析。
:::

## 本地 systemd 部署

如果你不想使用 Docker，可以使用本地部署：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- install
```

安装完成后访问：

```text
http://服务器IP:3000
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

## 配置域名和 HTTPS

建议使用 Nginx、Caddy 或宝塔反向代理到面板端口。

Nginx 示例：

```nginx
server {
    listen 80;
    server_name panel.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

配置 HTTPS 后，面板公开地址建议填写：

```text
https://panel.example.com
```

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

更完整的初始化说明可以看 [首次初始化](./first-setup.md)。
