# 版本与文档更新

## 当前版本

| 组件 | 版本 |
| --- | --- |
| 面板 | 2.3.300 |
| Android / iOS | 2.4.18 |
| Agent | 2.2.212 |
| FXP 运行时 | 2.2.122 |

`2.3.300` 于 2026-11-13 启动发布：新增隧道和转发链整条链路 TCP / UDP 测速，提供实时速度、仪表盘、曲线、详细结果和导出；邮箱提醒支持管理员汇总抄送，修复提醒失败处理并清理过期记录，同时更新英文文案和教程。请同步升级 Agent；FXP 运行时未改动。完整记录见 [中文 changelog](https://github.com/poouo/Forwardx/blob/main/CHANGELOG.md) / [English changelog](https://github.com/poouo/Forwardx/blob/main/CHANGELOG.en.md)。

表中是仓库源码里的版本号。各平台安装包由 GitHub Actions 分别构建，完成时间有先后，升级前请确认 [GitHub Releases](https://github.com/poouo/Forwardx/releases) 里已经有对应附件。Android 和 iOS 共用一个 App 版本号，与面板、Agent、FXP 的版本号各自独立；iOS 包需要 [自行签名](./mobile-app.md)。

## 需要升级 Agent 的功能

- 链路测速要求所有参与主机升级至 Agent `2.2.212`，并允许测速临时端口通过防火墙。详见 [隧道测速](./tunnels.md) 和 [转发链测速](./port-chains.md)。
- Agent 代理从 Agent `2.2.197` 起提供。
- 日志轮转、连接数上报、原生流量统计回退和 Agent 队列优化需要相应版本的 Agent；GOST 统计回退还要同时更新面板并重新应用规则配置。
- 同一 Token 换机接管需要同时升级 Agent 和 FXP，旧版 Agent 不会停止同步。
- 转发运行时仍为 `3.2.6-forwardx.2`。运行时文件通过 Agent 升级流程更新，正在运行的旧进程重启后才使用新文件，建议放在维护窗口进行。
- V3 隧道暂未在面板开放；它要求入口和出口同时升级，不兼容旧 V3。

升级 Agent 时，更新二进制、首次启用控制接口或修改已有监听都可能重启转发运行时，已有连接会中断。升级前先 [备份](./upgrade-backup.md)，升级后用真实的 TCP/UDP 业务验证。相关说明见 [Agent](./agent.md) 和 [数据库](./database.md)。

## 开发者公告

面板会读取本仓库 `main` 分支的 `announcements/developer.json`，用来提醒受影响的版本升级。公告只弹给管理员，不执行命令，也不会自动升级；站点自己的公告和登录弹窗不受影响。

- **检查时机**：管理员登录、切换后台页面或回到前台时，距上次检查满 30 分钟才去 GitHub 检查一次。没有定时轮询，无人访问时不会检查。
- **缓存**：一台面板的所有管理员共用一次拉取结果，失败后同样等 30 分钟再试；成功结果最多缓存 24 小时，过期的公告不显示。重启面板后首次访问会重新检查。
- **网络**：可以使用系统设置里的 GitHub 加速地址，失败后回退直连。无法访问 GitHub 时收不到公告。
- **确认记录**：按 `id + revision` 记录每位管理员是否已确认，保存在数据库里，换浏览器不会重复弹出。每位用户保留最近 200 条。
- **旧版本**：旧面板需要先更新才有这套机制；手机 App 内置的旧网页需要更新 App。

面板和 Agent 的自动版本检查使用同样的触发方式和 30 分钟缓存。关闭「自动检查更新」只停止版本检查，不影响开发者公告；手动点「检查更新」或通过 Telegram 检查随时可用。

### 发布公告（维护者）

更新 `announcements/developer.json` 即可，不需要改版本号或发布安装包。修改已发布的公告要递增 `revision` 才会重新提醒；停止提醒时把该项从文件里删掉。格式示例（不是真实公告）：

```json
{
  "version": 1,
  "announcements": [{
    "id": "example-update-notice",
    "revision": 1,
    "publishedAt": "2026-10-28T00:00:00Z",
    "minVersion": "2.3.280",
    "fixedVersion": "2.3.999",
    "title": { "zh-CN": "更新提醒", "en": "Update notice" },
    "content": { "zh-CN": "请查看对应版本更新说明后按需升级。", "en": "Please review the release notes and update as needed." }
  }]
}
```

- `minVersion` / `maxVersion`：可选，含边界的适用版本范围。不填则新旧面板都会收到。
- `fixedVersion`：只提醒低于该版本的面板，并显示官方 Release 链接。
- `publishedAt` / `expiresAt`：开始和结束展示的时间，`expiresAt` 可选。
- 标题和内容都要提供中英文。文件不超过 128 KiB，最多 100 条，`id` 不能重复。

## 源码、安装包和文档站各自更新

- **源码**：推送到 main 后，镜像、面板包和 APK/IPA 还要等构建完成。
- **安装包**：以 [GitHub Releases](https://github.com/poouo/Forwardx/releases) 里实际出现的附件为准，各平台完成时间不同。
- **文档站**：由 main 分支的 `docs` 目录单独构建和部署，不随面板镜像更新。

文档站左上角显示构建时的面板版本，[构建信息](../build-info.json) 里有版本、提交和构建时间。它们说明的是文档本身，不是你安装的面板。

## 文档没有更新时

1. 查看 [Docs 工作流](https://github.com/poouo/Forwardx/actions/workflows/docs.yml)，确认最新提交的构建和部署都成功。
2. 任务还在排队时，网站显示的是上一次部署的内容，清浏览器缓存没有用。
3. 构建或部署失败时查看对应步骤的日志，并在仓库 Settings → Pages 确认 Source 是 GitHub Actions、github-pages 环境没有卡在审批。
4. 部署成功后对照构建信息再刷新页面；用了自定义域名、反向代理或 CDN 的，还要清它们的缓存。

维护者可以在 Docs → Run workflow 手动重新部署 main 分支的文档。
