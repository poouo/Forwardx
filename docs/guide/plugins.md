# 插件开发

ForwardX 插件用于给面板增加可选能力。当前版本优先支持声明式插件：插件可以声明设置项、说明页、数据资产、扩展点、受控动作和主机使用页，面板负责安装、更新、渲染和保存配置。

插件入口默认隐藏，管理员可在「系统设置 -> 左侧导航栏菜单展示设置 -> 管理菜单开关」中开启“插件”。开启后左侧会显示「插件」菜单。

## 安装方式

管理员可以通过三种方式安装插件：

- 官方插件：面板从 ForwardX GitHub 仓库读取 `plugins/official-store.json`，页面中可一键安装。
- GitHub 仓库：填写仓库地址、分支和 manifest 路径后安装。
- 上传插件包：上传 `.zip`、`.tar.gz` 或 `.tgz` 插件包。

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
  "detailsMarkdown": "这里可以写更完整的插件介绍，支持 **Markdown**。\n\n- 说明插件解决什么问题\n- 说明安装后在哪里使用\n- 说明是否会同步文件、调用动作或展示页面",
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

压缩包插件需要在包内包含 `forwardx-plugin.json`、`plugin.json` 或 `.forwardx/plugin.json`。压缩包内的文本资产会被读取到数据库。普通插件不会执行任意后端代码；面板内置白名单动作可以把插件声明的脚本和数据作为受控 Agent 动作下发。

## 动作

`actions` 用来声明插件按钮。当前支持：

| 类型 | 说明 |
| --- | --- |
| `noop` | 测试动作 |
| `http.request` | 由面板后端按 manifest 声明发起受控 HTTP/HTTPS API 请求 |
| `data.asset.refresh` | 刷新 GitHub 来源插件资产 |
| `data.whitelist.refresh` | 刷新白名单类插件数据 |

`http.request` 需要插件同时声明 `net:http` 权限。它不会执行插件后端代码，只会按 manifest 中声明的 `request` 发起 HTTP/HTTPS 请求，并限制超时和响应体大小。请求中的字符串支持模板变量：

- <code v-pre>{{settings.xxx}}</code>：引用插件设置项，例如 `baseUrl`、`apiToken`。
- <code v-pre>{{input.xxx}}</code>：引用动作执行前让管理员填写的输入项。
- <code v-pre>{{plugin.id}}</code>、<code v-pre>{{plugin.name}}</code>、<code v-pre>{{plugin.version}}</code>：引用当前插件信息。

`request` 支持 `method`、`url` 或 `baseUrlSetting + path`、`headers`、`query`、`body`、`timeoutMs`、`responseType` 和 `auth`。`auth` 可选 `bearer`、`header`、`cookie`，也可以直接通过 `headers` 声明认证头。

对接 3x-ui 这类提供 Swagger/OpenAPI 的面板时，可以把面板地址和 API Token 放到 `settingsSchema`，再把具体接口做成动作。示例：

```json
{
  "permissions": ["net:http"],
  "settingsSchema": [
    {
      "key": "baseUrl",
      "label": "3x-ui 面板地址",
      "type": "url",
      "placeholder": "https://xui.example.com"
    },
    {
      "key": "apiToken",
      "label": "API Token",
      "type": "password"
    }
  ],
  "actions": [
    {
      "id": "list-inbounds",
      "label": "读取入站列表",
      "type": "http.request",
      "request": {
        "method": "GET",
        "baseUrlSetting": "baseUrl",
        "path": "/panel/api/inbounds/list",
        "headers": {
          "Authorization": "Bearer {{settings.apiToken}}"
        },
        "responseType": "json",
        "timeoutMs": 10000
      }
    },
    {
      "id": "get-inbound",
      "label": "读取指定入站",
      "type": "http.request",
      "inputSchema": [
        {
          "key": "inboundId",
          "label": "入站 ID",
          "type": "number",
          "required": true
        }
      ],
      "request": {
        "method": "GET",
        "baseUrlSetting": "baseUrl",
        "path": "/panel/api/inbounds/get/{{input.inboundId}}",
        "headers": {
          "Authorization": "Bearer {{settings.apiToken}}"
        },
        "responseType": "json"
      }
    }
  ]
}
```

具体 3x-ui 路径、请求体和认证方式以 3x-ui 自身 OpenAPI 为准。ForwardX 插件层只负责保存配置、渲染输入表单、发起声明式请求和展示响应结果。

## 使用页

插件可以通过 `usageViews` 声明自己的使用界面。面板不会执行插件前端代码，而是按声明渲染通用 UI。

当前支持的使用页类型：

| 类型 | 说明 |
| --- | --- |
| `host-asset-sync` | 选择主机、插件字段和可选资产，保存后由 Agent 心跳同步到主机本地目录 |

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
      "assetMode": "selected-assets",
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
      "operationSelector": {
        "label": "执行方式",
        "defaultValue": "sync",
        "options": [
          { "value": "sync", "label": "仅同步" }
        ]
      },
      "fields": [
        {
          "key": "mode",
          "label": "模式",
          "type": "select",
          "options": [
            { "value": "basic", "label": "基础" }
          ]
        }
      ],
      "noteField": {
        "label": "备注"
      },
      "footer": {
        "submitLabel": "保存使用配置"
      }
    }
  ]
}
```

`storageKey` 用于保存这个使用页的配置。省略时面板会按插件 ID 和使用页 ID 自动生成。

`assetMode` 默认为 `selected-assets`，用户需要选择具体文件。设置为 `all-plugin-assets` 时，面板会把插件包内允许同步的文本资产整体下发，适合需要脚本、数据目录和配置一起工作的主机类插件。

`fields` 支持 `text`、`textarea`、`boolean`、`select` 和 `multi-select`。这些字段不会执行插件前端代码，而是由面板按声明渲染并保存。

## 官方插件商店

官方插件清单在仓库的 `plugins/official-store.json`：

```json
{
  "version": 1,
  "items": [
    {
      "id": "china-region-whitelist",
      "name": "ForwardX 中国区域白名单",
      "description": "为 ForwardX 面板适配的中国区域白名单插件。",
      "detailsMarkdown": "为 ForwardX 面板适配的中国区域白名单插件。\n\n- 支持全国 CN、省级 CIDR、ASN 和端口优先白名单。\n- 安装后可在插件使用页选择主机和执行方式。\n- 支持状态查看、规则预演、应用规则和清理规则。",
      "version": "0.2.0",
      "releaseDate": "2026-07-10",
      "updatedAt": "2026-07-10",
      "changelog": "补齐白名单脚本能力，支持主机配置生成、预演、应用、状态查看、清理规则和完整数据下发。",
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
      "packagePath": "plugins/packages/china-region-whitelist.tar.gz",
      "category": "data",
      "permissions": ["data:whitelist"],
      "extensionPoints": ["data.whitelist"],
      "official": true
    }
  ]
}
```

管理员打开插件页时，面板会在线读取这个清单；如果读取失败，会回退到面板内置的最小官方插件列表。

官方商店的一键安装优先下载仓库内的 `packagePath` 插件压缩包，例如 `plugins/packages/china-region-whitelist.tar.gz`。这些插件包提交在仓库中，不作为 GitHub Release 资产发布，面板升级包也不会携带插件包。更新插件包时，在本地执行：

```bash
pnpm plugins:package
```

执行后把生成的 `plugins/packages/*.tar.gz` 和对应清单一起提交即可。

`china-region-whitelist` 是 ForwardX 内置适配插件。插件定义、脚本和白名单数据都随本项目维护，数据位于 `plugins/china-region-whitelist/data/`，脚本入口位于 `plugins/china-region-whitelist/forwardx-agent-run.sh`。

如果需要把白名单下发到主机，进入插件详情的“使用”页，开启使用配置，选择生效主机、执行方式和白名单范围后保存。目标主机会在 Agent 心跳时收到同步动作，完整插件目录会写入 `/etc/forwardx/plugins/china-region-whitelist/`，面板生成的脚本配置会写入 `/etc/china-region-whitelist.conf`。

默认执行方式是“仅同步配置”，不会修改防火墙。选择“预演规则”可以先查看将要执行的 nftables/iptables 命令；选择“应用规则”才会正式下发规则；选择“清理规则”会清理该插件创建的规则和持久化配置。

## 当前边界

当前插件不会直接运行第三方 JavaScript 或后端代码。插件能力通过 manifest 声明，由面板解释执行。普通插件只保存配置、展示页面和同步资产；白名单这类面板内置受控插件可以通过 Agent 动作运行随插件包下发的脚本。
