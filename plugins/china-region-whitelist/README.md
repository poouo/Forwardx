# ForwardX 中国区域白名单

这个插件是 ForwardX 面板内置的中国区域白名单适配插件，用于把项目内维护的白名单数据同步到选中的 Agent 主机。

插件的“使用”界面由 `forwardx-plugin.json` 中的 `usageViews` 声明提供，面板只负责按声明渲染通用的主机选择、文件选择和保存动作。

安装后可以在插件详情里执行“刷新白名单数据”，面板会读取本项目 `plugins/china-region-whitelist/data/` 目录下的数据文件，并保存到插件资产中。

同步后的文件可以在“资产”页预览，也可以单独下载到本地使用。

需要让主机使用这些文件时，进入插件详情的“使用”页，选择生效主机和要同步的白名单文件后保存。目标主机会在 Agent 心跳时收到更新，文件会写入 `/etc/forwardx/plugins/china-region-whitelist/`。
