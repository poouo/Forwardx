# 版本与文档更新

## 当前源码版本标识

| 组件 | 源码标识 |
| --- | --- |
| 面板 | 2.3.295 |
| Android / iOS | 2.4.13 |
| Agent | 2.2.208 |
| FXP 运行时 | 2.2.122 |

`2.3.295` 于 2026-11-01 启动正式发布，各平台安装包由 GitHub Actions 构建。旧版面板不一定具备下列功能；是否可以升级以 Release 实际附件为准。

本次增加按主机设置 Agent 面板连接地址，修复故障更换间歇卡顿与自动换 IP 异常，改善 Telegram 连接，并减少公告、版本检查的后台请求。升级前请先备份；见 [升级和备份](./upgrade-backup.md)、[Agent](./agent.md) 和 [数据库](./database.md)。最近版本见 [中文 changelog](https://github.com/poouo/Forwardx/blob/main/CHANGELOG.md) / [English changelog](https://github.com/poouo/Forwardx/blob/main/CHANGELOG.en.md)。

该表反映仓库中的版本字段，不证明对应 Release 已构建完成。安装或升级时，以实际 Release 附件和构建任务结果为准；各平台安装包可能先后完成。

Agent 代理功能自 `2.2.197` 起提供；当前源码 Agent 为 `2.2.208`，FXP 为 `2.2.122`（本次未改动）。本次 Agent 支持面板连接地址变更后及时切换通信入口；故障更换修复还需通过 Agent 升级安装流程更新配套转发运行时 `3.2.6-forwardx.2`。运行中的旧进程需在维护窗口重启才会使用新文件。日志轮转、连接数上报、原生流量统计回退与 Agent 队列优化也需相应版本 Agent；GOST 统计回退还需同步更新面板并应用规则配置。同 Token 换机接管需配套升级 Agent / FXP，旧版 Agent 不具备停止同步的接管处理。V3 的入口与出口需同时升级，不兼容旧 V3，且暂未在面板开放。增量新增保护不等于升级过程中业务不断：更新二进制、首次启用控制接口或修改已有监听仍可能重启运行时。确认安装附件已生成后，按需 [备份并升级](./upgrade-backup.md)，升级后验证真实 TCP/UDP 业务。

Android 和 iOS 使用相同的应用版本号；面板、Agent 和 FXP 分别维护自己的版本。安装包按平台识别更新，不会把 APK 当作 IPA。iOS 包仍需 [自行签名](./mobile-app.md)。

## 开发者公告（独立于升级）

当前源码改为**按管理员访问触发**：登录进入后台、切换后台页面或回到前台时，距上次检查满 30 分钟才检查 GitHub，并复用现有公告弹窗。不设置定时轮询；无人访问、仅保持页面静置或页面在后台时，不会因为时间到期自行检查。无需先升级到公告提及的版本；可以仅向受影响的旧版本提醒升级，普通用户不弹开发者升级公告，站点自己的普通公告和登录弹窗不变。旧安装需更新面板，手机内置旧网页需更新 App 后才能使用新机制。

公告源固定为仓库 `main` 分支的 `announcements/developer.json`，与 Release 标签分开发布，可复用系统设置中的 GitHub 加速地址，失败后回退直连。每台面板共享一次拉取，不为每个浏览器请求 GitHub；失败后也等待满半小时，直到下一次管理员访问才重试，最多保留 24 小时的成功缓存，已过期公告不会展示。离线或无法访问 GitHub 时不能保证准时收到。

面板和 Agent 的自动版本检查采用相同的访问触发方式和 30 分钟共享缓存，不再由服务器每 6 小时或启动后定时检查；关闭「自动检查更新」会停止自动版本检查，但不影响开发者公告。管理员主动点击「检查更新」或通过 Telegram 手动检查仍可立即检查。共享缓存是进程内状态，重启面板后首次管理员访问会重新检查。

公告按 `id + revision` 为每位管理员在当前数据库中记录确认状态，更换浏览器也不会重复弹出；修改内容需要递增 `revision` 才会重新提醒。单用户最多保留最近 200 个确认记录；停止发布时将该项移出源文件。公告不执行命令，也不会自动升级。

维护者发布时只需更新上述 JSON，无需修改版本号或发布安装包。示例（仅为格式说明，不是已发布的修复通知）：

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

`minVersion` / `maxVersion` 是可选的含边界适用范围；设置 `fixedVersion` 后，仅提醒低于修复版本的安装，并显示官方 Release 链接。通用公告不填版本条件，新老面板均可接收。`publishedAt` 控制开始展示，可选 `expiresAt` 控制到期；标题与内容均提供中英文。源文件总大小不超过 128 KiB，最多 100 项，公告 ID 不重复。

## 区分源码、安装包与文档站

- **源码已推送**：不代表镜像、面板包、APK/IPA 已构建完成。
- **Release**：以 [GitHub Releases](https://github.com/poouo/Forwardx/releases) 的实际附件及各构建任务为准；不同平台可先后完成。
- **文档站**：由 main 分支的 `/docs` 单独构建并部署，不随容器镜像自动更新。

文档站左上角显示构建时的面板版本；[构建信息](../build-info.json) 提供版本、提交和构建时间，可用于判断页面是否仍是旧版本。它描述的是文档，不是你已安装面板的版本。

## 文档未更新时

1. 查看 [Docs 工作流](https://github.com/poouo/Forwardx/actions/workflows/docs.yml)，确认最新提交的 build、deploy 和发布校验均成功。
2. 如果任务长时间 queued / pending，文档仍可能是上一次成功部署的内容；不是清空浏览器缓存就一定能解决。
3. 构建或部署失败时查看对应步骤；管理员在仓库 Settings → Pages 中确认 Source 为 GitHub Actions，并检查 github-pages 环境是否需要审批。
4. 部署成功后核对构建信息，再刷新页面。自定义域名、反向代理或 CDN 还需检查自身缓存。

仓库维护者可通过 Docs → Run workflow 重发当前 main 文档。工作流会检查版本与提交，不再只以“附件上传成功”判断网站已经更新。
