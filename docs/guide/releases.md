# 版本与文档更新

## 当前源码版本标识

| 组件 | 源码标识 |
| --- | --- |
| 面板 | 2.3.284 |
| Android / iOS | 2.4.2 |
| Agent | 2.2.197 |
| FXP 运行时 | 2.2.118 |

本次更新包含 Agent SOCKS / HTTP 代理、`fwxm` SSH 交互管理、30 天延迟与在线历史、可选推广返佣与工单、工单通知开关、本地头像及界面优化，并重新整理中英文 README 和部署文档。完整历史见 [中文 changelog](https://github.com/poouo/Forwardx/blob/main/CHANGELOG.md) / [English changelog](https://github.com/poouo/Forwardx/blob/main/CHANGELOG.en.md)。

该表反映仓库中的版本字段，不证明对应 Release 已构建完成。安装或升级时，以实际 Release 附件和构建任务结果为准；各平台安装包可能先后完成。

Agent 代理功能需升级至 `2.2.197`；本次 FXP 运行时保持 `2.2.118`。从旧版本升级时，隧道增量新增与普通端口限制仍需配套 Agent / 运行时。增量新增保护不等于升级过程中业务不断：更新二进制、首次启用控制接口或修改已有监听仍可能重启运行时。升级前先 [备份](./upgrade-backup.md)，升级后验证真实 TCP/UDP 业务。

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
