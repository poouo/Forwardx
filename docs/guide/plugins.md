# 插件开发

ForwardX 插件用于给面板增加可选能力。当前版本优先支持声明式插件：插件可以声明设置项、说明页、数据资产、扩展点和受控动作，面板负责安装、更新、渲染和保存配置。

插件入口默认隐藏，管理员可在「系统设置 -> 左侧导航栏菜单展示设置 -> 管理菜单开关」中开启“插件”。开启后左侧会显示「插件」菜单。

## 安装方式

管理员可以通过三种方式安装插件：

- 官方插件：面板从 ForwardX GitHub 仓库读取 `plugins/official-store.json`，页面中可一键安装。
- GitHub 仓库：填写仓库地址、分支和 manifest 路径后安装。
- 上传插件包：上传或粘贴 JSON，也可以上传 `.zip`、`.tar.gz` 或 `.tgz` 插件包。

官方插件列表本身也在 GitHub 上维护，所以新增官方插件不需要用户手动输入仓库地址。

面板安装本身不会自动安装任何插件。插件入口默认隐藏，管理员开启后再到插件商店手动安装。

## Manifest

插件仓库推荐在根目录提供 `forwardx-plugin.json`。面板也会尝试读取 `plugin.json` 和 `.forwardx/plugin.json`。

```json
{
  "schemaVersion": 1,
  "id": "demo-tools",
  "name": "演示插件",
  "version": "0.1.0",
  "description": "一个声明式插件示例",
  "author": "ForwardX",
  "logo": "https://example.com/plugin-logo.png",
  "releaseDate": "2026-07-09",
  "updatedAt": "2026-07-09",
  "changelog": "初始版本，提供说明页和设置项。",
  "tags": ["demo", "page"],
  "license": "MIT",
  "repository": "https://github.com/example/demo-tools",
  "features": [
    {
      "title": "说明页",
      "description": "在插件详情内展示 Markdown 页面。"
    },
    {
      "title": "设置项",
      "description": "提供可保存的插件配置。"
    }
  ],
  "permissions": ["ui:page"],
  "extensionPoints": ["sidebar.page"],
  "settingsSchema": [
    {
      "key": "title",
      "label": "展示标题",
      "type": "text",
      "defaultValue": "Hello ForwardX"
    }
  ],
  "pages": [
    {
      "id": "home",
      "title": "说明页",
      "contentType": "markdown",
      "assetPath": "README.md"
    }
  ],
  "actions": [
    {
      "id": "ping",
      "label": "运行测试动作",
      "type": "noop"
    }
  ],
  "assets": [
    {
      "path": "README.md",
      "label": "说明文档",
      "contentType": "text/markdown"
    }
  ]
}
```

## 设置项

`settingsSchema` 会在插件详情页渲染成表单。支持字段：

| 类型 | 用途 |
| --- | --- |
| `text` | 单行文本 |
| `textarea` | 多行文本 |
| `password` | 密钥类输入 |
| `number` | 数字 |
| `boolean` | 开关 |
| `select` | 下拉选择 |
| `url` | HTTP/HTTPS 地址 |

设置值会保存在插件 manifest 的 `settingsValues` 中，由面板校验类型后写入数据库。

## 页面和资产

`pages` 可以声明插件内页面。页面内容可以直接写在 `content`，也可以通过 `assetPath` 引用上传包里的资产。

上传包示例：

```json
{
  "manifest": {
    "id": "hello-panel",
    "name": "Hello Panel",
    "version": "0.1.0",
    "author": "ForwardX",
    "updatedAt": "2026-07-09",
    "features": [
      {
        "title": "插件页面",
        "description": "展示一个 Markdown 页面。"
      }
    ],
    "permissions": ["ui:page"],
    "extensionPoints": ["sidebar.page"],
    "pages": [
      {
        "id": "home",
        "title": "首页",
        "contentType": "markdown",
        "assetPath": "README.md"
      }
    ]
  },
  "assets": {
    "README.md": "# Hello Panel\n这是一个插件页面。"
  }
}
```

资产会存入数据库，不会写入服务器任意目录。

压缩包插件需要在包内包含 `forwardx-plugin.json`、`plugin.json` 或 `.forwardx/plugin.json`。压缩包内的文本资产会被读取到数据库，面板不会执行包内脚本。

## 动作

`actions` 用来声明插件按钮。当前支持：

| 类型 | 说明 |
| --- | --- |
| `noop` | 测试动作 |
| `data.asset.refresh` | 刷新 GitHub 来源插件资产 |
| `data.whitelist.refresh` | 刷新白名单类插件数据 |

后续如果要增加更强的动作，建议先在面板后端加白名单动作，再让插件 manifest 调用该动作类型。

## 使用页

插件可以通过 `usageViews` 声明自己的使用界面。面板不会执行插件前端代码，而是按声明渲染通用 UI。

当前支持的使用页类型：

| 类型 | 说明 |
| --- | --- |
| `host-asset-sync` | 选择主机和插件资产文件，保存后由 Agent 心跳同步到主机本地目录 |

示例：

```json
{
  "usageViews": [
    {
      "id": "sync-to-hosts",
      "type": "host-asset-sync",
      "storageKey": "demoUsage",
      "title": "主机文件同步",
      "description": "选择主机和数据文件后，Agent 会把文件同步到指定目录。",
      "enableLabel": "启用同步",
      "targetDirectory": "/etc/forwardx/plugins/demo-tools",
      "hostSelector": {
        "title": "生效主机",
        "selectedLabel": "已选",
        "selectAllLabel": "全选",
        "clearLabel": "清空"
      },
      "assetSelector": {
        "title": "同步内容",
        "selectedLabel": "已选",
        "clearLabel": "清空"
      },
      "footer": {
        "submitLabel": "保存使用配置"
      }
    }
  ]
}
```

`storageKey` 用于保存这个使用页的配置。省略时面板会按插件 ID 和使用页 ID 自动生成。

## 官方插件商店

官方插件清单在仓库的 `plugins/official-store.json`：

```json
{
  "version": 1,
  "items": [
    {
      "id": "china-region-whitelist",
      "name": "ForwardX 中国区域白名单",
      "description": "为 ForwardX 面板适配的中国区域白名单数据插件。",
      "version": "0.1.0",
      "releaseDate": "2026-07-09",
      "updatedAt": "2026-07-09",
      "changelog": "提供 ForwardX 内置白名单数据的一键安装入口。",
      "features": [
        {
          "title": "白名单数据",
          "description": "维护中国区域 IP/域名数据来源。"
        }
      ],
      "tags": ["whitelist", "china-region", "data"],
      "author": "poouo",
      "repository": "https://github.com/poouo/Forwardx",
      "branch": "main",
      "manifestPath": "plugins/china-region-whitelist/forwardx-plugin.json",
      "packageRepository": "https://github.com/poouo/Forwardx",
      "packageBranch": "main",
      "category": "data",
      "permissions": ["data:whitelist"],
      "extensionPoints": ["data.whitelist"],
      "official": true
    }
  ]
}
```

管理员打开插件页时，面板会在线读取这个清单；如果读取失败，会回退到面板内置的最小官方插件列表。

`china-region-whitelist` 是 ForwardX 内置适配插件。插件定义和白名单数据都随本项目维护，数据位于 `plugins/china-region-whitelist/data/`。安装后进入插件详情执行“刷新白名单数据”，即可在“资产”页预览和下载同步后的文件。

如果需要把白名单下发到主机，进入插件详情的“使用”页，开启使用配置，选择生效主机和要同步的文件后保存。这个“使用”页来自插件 manifest 的 `usageViews` 声明。目标主机会在 Agent 心跳时收到同步动作，文件会写入 `/etc/forwardx/plugins/china-region-whitelist/`，目录中会包含选中的数据文件和 `manifest.json`。

## 当前边界

当前插件不会直接运行第三方 JavaScript、Shell 或后端代码。插件能力通过 manifest 声明，由面板解释执行。这样可以保持可扩展性，同时避免插件影响面板核心进程和数据库结构。白名单这类受控插件可以通过面板内置动作同步数据到 Agent。
