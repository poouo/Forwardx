# 插件开发

ForwardX 插件用于给面板增加可选能力。插件可以声明设置项、说明页、数据资产、扩展点、受控动作、主机使用页和 Agent 动态资源，面板负责安装、更新、权限校验、任务调度、状态保存和通用界面渲染。

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

压缩包插件需要在包内包含 `forwardx-plugin.json`、`plugin.json` 或 `.forwardx/plugin.json`。压缩包内的文本资产会被读取到数据库。插件不会执行任意面板后端代码；声明 `agent:read`、`agent:write` 或 `agent:execute` 后，可以让 Agent 在独立任务队列中执行插件包内固定脚本入口。

## 动作

`actions` 用来声明插件按钮。当前支持：

| 类型 | 说明 |
| --- | --- |
| `noop` | 测试动作 |
| `http.request` | 由面板后端按 manifest 声明发起受控 HTTP/HTTPS API 请求 |
| `agent.request` | 在使用页已选主机上执行插件包内固定脚本，并回传文本或 JSON 结果 |
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

### Agent 操作

`agent.request` 需要关联一个 `host-asset-sync` 使用页。目标主机来自该使用页已经保存的生效主机，不接受插件自行指定任意主机。

动作通过 `intent` 声明用途并使用对应权限：

| `intent` | 权限 | 用途 |
| --- | --- | --- |
| `read` | `agent:read` | 检测程序、读取配置、列表和运行状态 |
| `write` | `agent:write` | 新增、修改、删除或应用 Agent 配置 |
| `execute` 或省略 | `agent:execute` | 执行不能归类为资源读写的受控操作；省略时兼容旧插件 |

动态资源动作通常把 `agent.target` 设置为 `selected-hosts`，面板只向当前界面选中的单台 Agent 下发。普通批量动作仍可使用 `usage-hosts`。

```json
{
  "id": "demo-tools",
  "permissions": ["agent:read"],
  "usageViews": [
    {
      "id": "sync-to-hosts",
      "type": "host-asset-sync",
      "title": "主机工具",
      "targetDirectory": "/var/lib/forwardx-agent/plugins/demo-tools",
      "assetMode": "all-plugin-assets"
    }
  ],
  "actions": [
    {
      "id": "read-status",
      "label": "读取主机状态",
      "type": "agent.request",
      "intent": "read",
      "inputSchema": [
        {
          "key": "scope",
          "label": "状态范围",
          "type": "text",
          "defaultValue": "summary"
        }
      ],
      "agent": {
        "executor": "script",
        "interpreter": "bash",
        "target": "selected-hosts",
        "usageViewId": "sync-to-hosts",
        "entry": "status.sh",
        "arguments": ["--json", "{{input.scope}}"],
        "timeoutMs": 15000,
        "outputType": "json"
      }
    }
  ]
}
```

`targetDirectory` 必须位于 `/var/lib/forwardx-agent/plugins/<插件 ID>` 下。`entry` 必须是插件同步目录内的相对路径，不能包含 `..`。`arguments` 以参数数组传递，支持与 HTTP 动作相同的模板变量，不会拼接为任意 shell 命令。当前支持 `bash`、`sh` 和 `python3` 解释器，目标主机需要自行具备对应解释器。

插件任务需要 Agent `2.2.149` 或更高版本，并使用独立 worker，不占用转发规则执行队列。首次执行前需要先保存插件使用配置，让 Agent 同步对应插件 ID 和版本的脚本；未同步、离线或版本不匹配时，动态资源界面会禁用写入按钮并显示原因。

单个任务最长 60 秒，标准输出和错误输出分别限制为 256KB。`outputType: "json"` 时，脚本标准输出必须是完整 JSON；面板会按主机展示等待中、执行中、成功、已生效、离线、失败和超时状态。动态资源最近一次任务状态会写入数据库，刷新页面或面板重启后仍可看到最后状态和错误原因。

### 结构化结果 `resultSchema`

`agent.request` 返回 JSON 时，可以声明 `resultSchema`，让面板渲染信息卡或表格，不再固定展示原始 JSON。

```json
{
  "id": "read-services",
  "label": "读取服务",
  "type": "agent.request",
  "intent": "read",
  "agent": {
    "executor": "script",
    "target": "selected-hosts",
    "usageViewId": "sync-to-hosts",
    "entry": "manage.sh",
    "arguments": ["list"],
    "outputType": "json"
  },
  "resultSchema": {
    "type": "table",
    "itemsPath": "items",
    "fields": [
      { "key": "name", "label": "名称", "copyable": true },
      { "key": "status", "label": "状态", "type": "statusBadge" },
      { "key": "token", "label": "Token", "secret": true, "revealable": true, "copyable": true },
      { "key": "url", "label": "管理地址", "openable": true }
    ]
  }
}
```

`resultSchema.type` 支持：

- `keyValue`：键值信息卡。
- `table`：数组表格，通过 `itemsPath` 指定数组路径。

字段类型支持 `text`、`number`、`boolean`、`statusBadge`、`code` 和 `datetime`。`copyable` 显示复制按钮，`openable` 只允许打开 HTTP/HTTPS 地址。`secret` 默认遮挡；同时声明 `revealable` 且插件拥有 `secret:reveal` 权限时，用户才能点击显示和复制。

没有声明 `resultSchema` 的旧插件继续展示原始 JSON，不受影响。

## Agent 动态资源 `resourceSchema`

`resourceSchema` 用于声明通用节点管理界面。插件只负责通过固定 Agent 脚本读取和保存数据，ForwardX 自动提供 Agent 选择、列表、详情、编辑表单、删除确认、任务状态和刷新流程。

```json
{
  "permissions": ["read:hosts", "agent:read", "agent:write", "ui:interactive"],
  "resourceSchema": {
    "id": "services",
    "type": "agent-resource",
    "title": "服务管理",
    "usageViewId": "sync-to-hosts",
    "rowKey": "serviceId",
    "idInputKey": "serviceId",
    "onOpen": "list-services",
    "itemsPath": "items",
    "detailAction": {
      "actionId": "service-detail",
      "inputKey": "serviceId"
    },
    "columns": [
      { "key": "name", "label": "名称", "copyable": true },
      { "key": "status", "label": "状态", "type": "status" },
      { "key": "port", "label": "端口", "type": "number" }
    ],
    "fields": [
      {
        "key": "protocol",
        "label": "协议",
        "type": "select",
        "optionsSource": {
          "sourceId": "capabilities",
          "path": "protocols",
          "valueKey": "value",
          "labelKey": "label",
          "disabledKey": "disabled"
        }
      },
      {
        "key": "port",
        "label": "端口",
        "type": "number",
        "required": true,
        "visibleWhen": [{ "field": "protocol", "operator": "in", "value": ["tcp", "udp"] }]
      },
      {
        "key": "tls",
        "label": "TLS",
        "type": "boolean",
        "disabledWhen": [{ "field": "source.capabilities.tlsAvailable", "operator": "falsy" }]
      }
    ],
    "sources": [
      {
        "id": "capabilities",
        "actionId": "read-capabilities",
        "triggers": ["onOpen", "onHostSelected"]
      }
    ],
    "operations": {
      "create": { "actionId": "create-service", "refreshAfter": ["list"] },
      "update": { "actionId": "update-service", "refreshAfter": ["list"] },
      "delete": {
        "actionId": "delete-service",
        "confirmRequired": true,
        "refreshAfter": ["list"]
      }
    }
  }
}
```

`onOpen` 会在打开资源管理或切换 Agent 时调用列表动作。点击一行后，面板把 `rowKey` 对应的稳定 ID 传给 `detailAction`，读取详情并自动回填 `fields`。新增、修改和删除时会自动传递：

- `resourceId`：当前资源稳定 ID。
- `idInputKey` 指定的字段，例如 `serviceId`。
- `payload`：当前编辑表单的完整对象。
- 所有表单字段的顶层值。

因此插件不需要让用户手工填写或复制节点编号、名称和端口。动作参数可以使用 <code v-pre>{{input.serviceId}}</code> 和 <code v-pre>{{input.payload}}</code>。

`refreshAfter` 指定动作成功后自动重新加载的数据源。`sources` 还可以声明 `onOpen`、`onHostSelected` 或 `manual` 触发方式；字段的 `optionsSource` 可从任意已加载数据源生成实时选择项。

`visibleWhen` 和 `disabledWhen` 支持 `eq`、`neq`、`in`、`not-in`、`truthy` 和 `falsy`。条件既可以读取其他表单字段，也可以用 `source.<数据源 ID>.<路径>` 读取 Agent 返回能力。

每个数据源缓存都按 `插件 + resourceSchema + Agent` 隔离。切换主机时会取消接受上一台主机的迟到结果，不会混用列表、详情或选项缓存。

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
      "targetDirectory": "/var/lib/forwardx-agent/plugins/demo-tools",
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
      "version": "0.4.0",
      "releaseDate": "2026-07-12",
      "updatedAt": "2026-07-12",
      "changelog": "接入通用 Agent 动态资源管理，支持按主机实时读取、编辑、应用和清理白名单配置。",
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
      "permissions": ["data:whitelist", "read:hosts", "agent:read", "agent:write", "ui:interactive"],
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

如果需要把白名单下发到主机，进入插件详情的“使用”页，开启使用配置并选择生效主机。目标主机会在 Agent 心跳时收到插件程序和数据，完整插件目录写入 `/var/lib/forwardx-agent/plugins/china-region-whitelist/`。

在“Agent 资源管理”中选择某台在线主机后，面板会自动读取该机当前配置和规则状态。点击编辑会读取详情并回填表单；“保存并应用”只修改当前 Agent，“清理规则”会清理当前 Agent 上由插件创建的规则和配置。

各 Agent 的配置和状态独立保存。周期性插件资源同步不会覆盖已经存在的 `/etc/china-region-whitelist.conf`，保存或清理完成后界面会自动重新读取实际状态。

## 当前边界

插件不会直接运行第三方 JavaScript 或面板后端代码。插件能力通过 manifest 声明，由面板解释执行。声明 Agent 权限的插件可以执行随插件包下发的固定脚本入口；管理员仍应只安装可信插件，因为 Agent 通常拥有修改系统网络配置所需的权限。
