# ForwardX Live2D 看板娘

这是 ForwardX 对 [stevenjoezhang/live2d-widget](https://github.com/stevenjoezhang/live2d-widget) 的官方适配插件。

插件安装后仍处于停用状态。启用插件并保存设置后，面板浏览器才会加载固定版本 `live2d-widgets@1.0.1` 的上游 CSS/JavaScript；插件未启用时不会加载这些资源，也不会创建后台任务。面板只解释这份 manifest 和设置，不执行插件包内的任意前端代码。

## 模型资源

本插件不包含 Live2D 模型、贴图或动作数据。默认 `cdnPath` 指向上游示例模型目录，用户可以改为自己的静态模型仓库。模型资源的版权、使用范围和是否允许商业使用由对应模型作者或仓库单独决定；启用前请确认其许可。

提示配置默认使用 ForwardX 随面板发布的 `waifu-tips.json`，可以改为面板内路径或自托管的 JSON 文件。`modelId` 只作为浏览器首次选择模型时的默认值，模型切换后由上游保存在浏览器本地。

## 许可证

ForwardX 的适配代码和配置按本项目的 `AGPL-3.0-only` 发布。运行时依赖的 `stevenjoezhang/live2d-widget` 代码按 `GPL-3.0-or-later` 发布，相关声明见 `THIRD_PARTY_NOTICES.md`。Live2D Cubism Core 和模型资源不属于本项目，须分别遵守其提供方的许可。
