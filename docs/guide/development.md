# 本地开发

源码开发与生产部署是两套流程。需要正式服务时使用 [Docker](./deploy-docker.md) 或 [本地发布包](./deploy-local.md)，不要向公网开放开发自动登录模式。

## 准备

安装 Node.js 22+，使用与 CI 一致的 pnpm 版本（当前为 10.28.1）。进入项目根目录：

~~~bash
pnpm install
pnpm dev:panel
~~~

dev:panel 启动真实页面、路由和组件，使用项目 .dev 目录中的隔离开发数据，并提供开发管理员自动登录。

| 项目 | 默认值 |
| --- | --- |
| 网页地址 | http://127.0.0.1:5173/ |
| 公开主机监控 | http://127.0.0.1:5173/dev |
| 后端端口 | 3000 |
| SQLite 数据库 | .dev/forwardx-dev.db |
| 数据库配置 | .dev/database.json |
| 开发登录密钥 | .dev/jwt.secret |
| 开发管理员 | dev.admin@forwardx.local / forwardx-dev |

以终端实际打印的地址为准。按 Ctrl+C 停止。开发库会保留上一次数据，不是每次启动重新清空。

端口冲突时可设置 FORWARDX_DEV_SERVER_PORT / FORWARDX_DEV_CLIENT_PORT 后重新启动；保持回环访问，不要将 HOST 改为公网地址后继续使用自动登录。

## pnpm dev 的区别

pnpm dev 直接启动 server/index.ts，不是隔离数据、自动登录的开发启动器。它会按实际环境及数据库配置运行后端，需要自己管理数据库和登录；不要用生产数据库随意测试。

首次测试页面建议使用 pnpm dev:panel。代理出现 ECONNREFUSED / ECONNRESET 时，检查后端是否启动成功、端口是否冲突以及终端前面的异常；不要仅屏蔽代理日志而忽略后端退出或连接被重置。

## 常用验证

~~~bash
pnpm exec tsc --noEmit
pnpm test:server
pnpm build
pnpm docs:build
pnpm check:versions
~~~

专项测试与移动端构建命令见 package.json 和 GitHub Actions 工作流。修改文档可使用 pnpm docs:dev 预览，提交前执行 docs:build 检查页面与链接。

测试账号和默认开发密码仅用于本地，不能作为生产账号或部署文档中的默认登录凭据。
