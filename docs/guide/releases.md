# 版本与文档更新

## 当前源码版本标识

| 组件 | 源码标识 |
| --- | --- |
| 面板 | 2.3.293 |
| Android / iOS | 2.4.11 |
| Agent | 2.2.206 |
| FXP 运行时 | 2.2.122 |

`2.3.293` 于 2026-10-28 启动正式发布，各平台安装包由 GitHub Actions 构建。旧版面板不一定具备下列功能；是否可以升级以 Release 实际附件为准。

本次增加独立开发者公告和 ForwardX 自编译转发运行时，改善数据库异常时的查询积压、后台汇总和 MCP 令牌管理，并加强管理权限、安装密钥安全及换 IP 提示。历史 Docker 部署请检查 JWT 配置；见 [升级和备份](./upgrade-backup.md)、[Agent](./agent.md) 和 [数据库](./database.md)。最近版本见 [中文 changelog](https://github.com/poouo/Forwardx/blob/main/CHANGELOG.md) / [English changelog](https://github.com/poouo/Forwardx/blob/main/CHANGELOG.en.md)。

该表反映仓库中的版本字段，不证明对应 Release 已构建完成。安装或升级时，以实际 Release 附件和构建任务结果为准；各平台安装包可能先后完成。

Agent 代理功能自 `2.2.197` 起提供；当前源码 Agent 为 `2.2.206`，FXP 为 `2.2.122`（本次未改动）。本次 Agent 发布版本递增用于配套交付 `forwardx-runtime 3.2.6-forwardx.1`，不改变 Agent 通信协议；节点需执行升级安装流程，运行中的旧进程还需在维护窗口重启才会使用新文件。日志轮转、连接数上报、原生流量统计回退与 Agent 队列优化也需相应版本 Agent；GOST 统计回退还需同步更新面板并应用规则配置。同 Token 换机接管需配套升级 Agent / FXP，旧版 Agent 不具备停止同步的接管处理。V3 的入口与出口需同时升级，不兼容旧 V3，且暂未在面板开放；V1/V2 协议保持兼容。增量新增保护不等于升级过程中业务不断：更新二进制、首次启用控制接口或修改已有监听仍可能重启运行时。确认安装附件已生成后，按需 [备份并升级](./upgrade-backup.md)，升级后验证真实 TCP/UDP 业务。

Android 和 iOS 使用相同的应用版本号；面板、Agent 和 FXP 分别维护自己的版本。安装包按平台识别更新，不会把 APK 当作 IPA。iOS 包仍需 [自行签名](./mobile-app.md)。

## 开发者公告（独立于升级）

接入远程公告机制的面板，会在管理员登录后、页面可见时每半小时检查一次 GitHub，并复用现有公告弹窗。无需先升级到公告提及的版本；可以仅向受影响的旧版本提醒升级，普通用户不弹开发者升级公告，站点自己的普通公告和登录弹窗不变。此前没有该机制的安装仍需先更新一次面板；旧版手机内置网页也需更新 App 才有这段轮询逻辑。

公告源固定为仓库 `main` 分支的 `announcements/developer.json`，与 Release 标签分开发布，可复用系统设置中的 GitHub 加速地址，失败后回退直连。每台面板共享一次拉取，不为每个浏览器请求 GitHub；失败后仍间隔半小时重试，最多保留 24 小时的成功缓存，已过期公告不会展示。离线或无法访问 GitHub 时不能保证准时收到。

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
