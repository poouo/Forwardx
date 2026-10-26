# 版本与文档更新

## 当前源码版本标识

| 组件 | 源码标识 |
| --- | --- |
| 面板 | 2.3.292 |
| Android / iOS | 2.4.10 |
| Agent | 2.2.205 |
| FXP 运行时 | 2.2.122 |

`2.3.292` 于 2026-10-26 启动正式发布，各平台安装包由 GitHub Actions 构建。旧版面板不一定具备下列功能；是否可以升级以 Release 实际附件为准。

本次包括数据库鉴权、展示查询及流量记账优化，修复数据库繁忙时误退出登录；转发规则批量操作支持后台队列与数量／百分比进度，面板及 Agent 日志按天轮转并保留最近三天，同时修复地球视图悬浮信息遮挡。使用方法见 [数据库](./database.md)、[转发规则](./rules.md) 和 [路径与日志](./paths-logs.md)。最近版本见 [中文 changelog](https://github.com/poouo/Forwardx/blob/main/CHANGELOG.md) / [English changelog](https://github.com/poouo/Forwardx/blob/main/CHANGELOG.en.md)。

该表反映仓库中的版本字段，不证明对应 Release 已构建完成。安装或升级时，以实际 Release 附件和构建任务结果为准；各平台安装包可能先后完成。

Agent 代理功能自 `2.2.197` 起提供；当前源码 Agent 为 `2.2.205`，FXP 为 `2.2.122`（本次未改动）。日志轮转、连接数上报、原生流量统计回退与 Agent 队列优化需更新 Agent；GOST 统计回退还需同步更新面板并应用规则配置。同 Token 换机接管需配套升级 Agent / FXP，旧版 Agent 不具备停止同步的接管处理。V3 的入口与出口需同时升级，不兼容旧 V3，且暂未在面板开放；V1/V2 协议保持兼容。增量新增保护不等于升级过程中业务不断：更新二进制、首次启用控制接口或修改已有监听仍可能重启运行时。确认安装附件已生成后，按需 [备份并升级](./upgrade-backup.md)，升级后验证真实 TCP/UDP 业务。

Android 和 iOS 使用相同的应用版本号；面板、Agent 和 FXP 分别维护自己的版本。安装包按平台识别更新，不会把 APK 当作 IPA。iOS 包仍需 [自行签名](./mobile-app.md)。

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
