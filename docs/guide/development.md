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

## 接口更新与加载排障

前端通过 Vite 热更新；当前 `dev:panel` 的后端以 `node --import tsx server/index.ts` 启动，没有文件监听重载。修改后端路由、Repository 或新增 API 后，应先在原终端按 Ctrl+C 停止，再运行 `pnpm dev:panel`，然后刷新网页。只刷新浏览器不会更新内存中的后端代码，不需要为此清空 `.dev` 数据。

页面持续转圈或加载后空白时，在浏览器开发者工具 Network 中检查 `/api/trpc/` 请求：

- `404 / No procedure found`：优先核对前后端是否来自同一份代码、旧后端是否已停止及代理目标端口。
- `401/403`：检查运行模式、登录和账号权限，不当作数据库性能问题处理。
- `5xx`：结合后端终端和日志查看错误。
- 成功但慢：分开测量接口、数据库查询与页面渲染；批量请求可能等待同批其他接口，失败重试也会延长表面加载时间。本地数据并不意味着可以跳过接口诊断。

自动选择备用端口时，以启动日志显示的后端及页面地址为准，避免浏览器仍访问另一个旧开发实例。

## 文档截图

使用本地 `dev:panel` 的真实页面和隔离开发数据截图；不要连接生产数据库或真实商户账号。先确认后端已加载当前代码，等待数据完成加载，关闭弹窗和错误提示后再截取需要说明的区域。

- 图片放在 `docs/guide/images/`，用功能命名，例如 `operations-finance.png`、`billing-ledger.png`；Markdown 使用相对路径并写清图意。
- 运维看板截图选择相同日期及用户范围，支付图表注明币种；移动端布局另用窄屏截图，不把桌面截图强行缩窄。
- Token、商户密钥、证书私钥、兑换码、用户联系方式和真实来源 IP 不能出现在公开图片中。界面必须有值时只使用明确的演示数据。
- 只裁切和脱敏，不修改截图中的数值或拼接成不存在的功能；截图注明为本地开发演示，不能证明线上已发布或真实业务通过。
- 添加图片后执行 `pnpm docs:build`，核对链接和最终页面。截图工具不可用时保留文字教程与待补清单，不添加不存在的图片链接。

### 截图素材与待补清单

`2.3.285` 已收录用户提供的本地开发截图，只做裁切，未拼接或修改业务数值。待补素材不插入图片链接：

| 文件名 | 状态与内容 |
| --- | --- |
| `operations-filters.png` | 已收录：看板日期、用户及自动刷新档位 |
| `operations-finance.png` | 已收录：账务环形图，支付币种 CNY |
| `billing-ledger.png` | 已收录：账单列表上部 |
| `host-notifications.png` | 已收录：其他配置中的上下线通知开关 |
| `entry-group-overview.png` | 已收录：入口组成员、状态和流量概览，不能代替节点诊断图 |
| `billing-pagination.png` | 已收录：账单列表底部的总数、页码与上一页/下一页 |
| `user-selector.png` | 已收录：展开的用户选择器，包含搜索、部分用户及翻页入口 |
| `port-entry-nodes.png` | 已收录：「节点详情」独立弹窗，示例为两台入口暂无启用规则（0/2、0/0）；不是运行失败示例 |

## 常用验证

~~~bash
pnpm exec tsc --noEmit
pnpm test:server
pnpm build
pnpm docs:build
pnpm check:versions
pnpm test:deployment-docs
~~~

专项测试与移动端构建命令见 package.json 和 GitHub Actions 工作流。修改文档可使用 pnpm docs:dev 预览，提交前执行 docs:build 检查页面与链接。

测试账号和默认开发密码仅用于本地，不能作为生产账号或部署文档中的默认登录凭据。
