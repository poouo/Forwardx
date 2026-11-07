# 主题管理、开发与接口

管理员在「系统设置 → 个性化配置 → 主题管理」安装和应用主题。主题作用于整个面板，所有账户跟随管理员选择；右上角的浅色、深色切换继续有效。

原有的墨色、松石、森绿、紫藤、暖阳、樱粉已作为六款内置主题提供，已有配色设置自动沿用。内置主题不能删除。主题 API v1 提供 CSS、设计变量，以及可选的 `views` 声明式布局与字段绑定：可重组主机卡片、选择指标、调整主机页区域顺序、修改登录文案和内容区、切换侧栏位置等。业务数据和交互由面板继续提供，不运行主题中的 JavaScript、HTML 页面或后端代码。需要新增业务功能时请参阅[插件开发](./plugins.md)。

## 安装、切换与恢复

1. 点击「下载开发模板」，解压并修改 `theme.json`、`theme.css`；也可直接[下载松石主题模板](/themes/forwardx-theme-starter.zip)。
2. 将文件打包为 **ZIP、RAR、TAR、TAR.GZ 或 TGZ**，上传主题压缩包；也可填写 HTTP/HTTPS 压缩包直链，点击「从链接导入」。按文件内容识别格式，下载链接可以包含查询参数、无需以压缩扩展名结尾。
3. 安装后主题出现在列表中，**不会自动启用**。点击「应用主题」切换全站主题，并在实际页面中查看效果。
4. 切换后当前页面更新；其他在线页面在前台运行时约一分钟内同步，刷新页面可立即同步。后台标签页会在恢复运行、下一次刷新时更新。
5. 升级同一主题时保留 `id` 并更新 `version`，先切换到其他主题，再勾选「替换相同 ID 的已安装主题」重新导入。当前使用中的主题不能替换或删除。

「恢复默认主题」会切换回内置墨色。如果主题样式导致按钮不可见，在当前面板地址增加 `?themeSafe=1`，例如 `https://panel.example.com/settings?themeSafe=1`。已有查询参数时用 `&themeSafe=1`。本次浏览器会话将暂时使用内置墨色，管理员可重新登录并切换主题；该模式不改变全站配置。修复后点击底部「退出安全模式」，或访问带 `themeSafe=0` 的地址。

主题存储在数据库系统配置中，随面板的系统配置备份和迁移保留，无需单独部署主题目录。自定义壁纸、Logo、公开首页和菜单设置仍分别管理；主题不会改写这些设置。

### 外部链接要求

- 使用能直接下载文件的公开 HTTP/HTTPS 地址，不是网盘预览页、仓库首页或需要 Cookie 的页面。GitHub Releases 应选择具体附件的下载地址。
- 压缩文件最大 **30MB**；下载总时限 **120 秒**，最多跟随 **3 次重定向**，每个地址都需要通过公网地址检查。连接阶段重新校验并固定解析地址，不能转向本机、私网或云元数据服务。
- 不接受 URL 中的用户名和密码，不发送面板会话、Cookie 或认证头给下载站点。私有文件可先下载到本机再上传。
- 下载服务器应支持 `Accept-Encoding: identity`，直接返回压缩文件原始内容；`Content-Type: application/gzip` 的 TAR.GZ 文件可以使用，额外的 HTTP `Content-Encoding: gzip` 不支持。
- 不定时检查或自动升级外部主题。重新导入相同 ID 时仍需勾选替换，并先停用当前主题。

## 目录与压缩格式

```text
theme.json             # 必须位于压缩包根目录
theme.css              # manifest 指定的入口样式表
assets/
  background.webp
  interface.woff2
README.md              # 可选
```

不要将整个外层目录一起打包。Linux/macOS 可以使用：

```sh
zip -r my-theme.zip theme.json theme.css assets README.md
tar -cf my-theme.tar theme.json theme.css assets README.md
tar -czf my-theme.tar.gz theme.json theme.css assets README.md
# .tgz 与 .tar.gz 使用同一种压缩格式
```

RAR 可使用 WinRAR 等工具创建，支持普通 RAR4/RAR5 压缩包，不支持加密包和分卷包。面板内置 RAR 解码器，不要求服务器安装 WinRAR 或 unrar。开发模板下载格式为 ZIP，可解压后重新打包为其他支持格式。

限制如下；`themes.capabilities` 可查询当前服务器的具体限制。

| 项目 | 限制 |
| --- | --- |
| 上传/下载压缩包 | 30MB |
| 解压后的文件合计 | 60MB |
| 单个文件（含图片、字体） | 10MB |
| 文件与目录总数 | 64 |
| `theme.json` | 64KB |
| 入口 CSS | 128KB |
| CSS 内嵌资源后的大小 | 40MB |
| 每个明暗模式的变量 | 128 个 |
| 自定义主题数量 | 12 个 |
| 已安装主题总存储 | 128MB |
| RAR 解压时限 | 10 秒 |

主题可以自带背景图、装饰图片和字体：放入 `assets/`，在样式表中通过 `url("assets/background.webp")` 等相对路径引用。推荐图片使用 WebP、字体使用 WOFF2，减少下载体积。资源会以 Base64 内嵌到主题样式中，体积约增加三分之一；重复引用也计入 40MB 的最终样式上限，可通过 CSS 变量复用同一资源。

本地上传的压缩包通过 Base64 JSON 传输，30MB 文件的请求体约为 40MB。使用 Nginx 等反向代理时，需要允许至少 41MB 的请求体，例如设置 `client_max_body_size 45m;`，否则可能在到达面板前收到 413。面板仅对通过管理员验证的单独 `themes.install` 请求提供较大额度，一次只处理一个主题上传；其他接口及混合批量请求仍沿用原有请求体限制。

路径使用字母、数字、下划线、短横线、点和 `/`，不允许绝对路径、`.`、`..` 目录段、重复文件或大小写冲突。RAR 的 Windows 路径分隔符会转换为 `/`。ZIP/TAR 符号链接、设备文件等特殊条目会拒绝；所有格式均在内存中解析，不写入站点目录。ZIP 不支持加密。可附带 `.css`、`.md`、`.txt`，图片限 PNG/JPEG/WebP/GIF，字体限 WOFF/WOFF2；不接收 JS、HTML 或 SVG。

## theme.json 规范

```json
{
  "apiVersion": 1,
  "id": "my-aurora-theme",
  "name": "极光工作台",
  "version": "1.0.0",
  "description": "宽屏、紧凑、青绿风格的后台主题",
  "author": "Your name",
  "base": "teal",
  "stylesheet": "theme.css",
  "variables": {
    "light": {
      "--primary": "#0f766e",
      "--primary-foreground": "#ffffff",
      "--background": "#f0f6f5",
      "--card": "#ffffff",
      "--foreground": "#172a28",
      "--pearl-surface": "#ffffff",
      "--radius": "0.75rem",
      "--theme-sidebar-width": "17rem"
    },
    "dark": {
      "--primary": "#5eead4",
      "--primary-foreground": "#102626",
      "--background": "#101f20",
      "--card": "#182b2c",
      "--foreground": "#e2f3ef",
      "--pearl-surface": "#182b2c"
    }
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `apiVersion` | 是 | 当前固定为 `1`，不兼容的版本会拒绝安装 |
| `id` | 是 | 3～64 位小写字母、数字、短横线，以字母开头；不可与六个内置主题 ID 重复 |
| `name` | 是 | 显示名称，最长 80 字符，支持中文 |
| `version` | 是 | `1.0.0` 或 `1.0.0-beta.1` 等三段版本，最长 64 字符 |
| `description` | 否 | 最长 500 字符 |
| `author` | 否 | 最长 100 字符 |
| `base` | 否 | `ink`、`teal`、`forest`、`wisteria`、`ember`、`sakura`，默认 `ink` |
| `stylesheet` | 是 | 相对根目录的 `.css` 文件路径 |
| `variables.light` | 否 | 浅色模式变量，也作为深色模式的变量缺省值 |
| `variables.dark` | 否 | 深色模式覆盖项 |
| `views` | 否 | 全局布局、登录文案、主机卡片字段和区域配置；省略时沿用原界面 |

未知 manifest 字段会被拒绝，以便发现拼写错误。变量名称匹配 `--[a-z][a-z0-9-]{0,63}`，值最长 512 字符。颜色支持 HEX、RGB、HSL、OKLCH 和 `var()`、`color-mix()` 等 CSS 表达式；值中不能含 `;`、`{`、`}`、`!` 或 URL。

面板先应用 `base` 的当前明暗配色，再覆盖 `variables.light`，深色模式继续覆盖 `variables.dark`。这些变量写入根元素；需要修改基础配色时应在 manifest 中设置，普通样式表中的 `:root` 声明不能覆盖已经写入的行内变量。`base` 也用于移动客户端内置启动图标的配色。

## 布局与内容开发：views

在 `theme.json` 中添加 `views`，就能选择展示的数据并改变结构，无需通过 CSS 伪元素替换文字。已有 CSS 主题不含 `views` 时仍可正常使用。新增能力可通过 `themes.capabilities.features` 查询。

### 全局布局与登录页

```json
{
  "views": {
    "shell": {
      "navigation": "right",
      "sidebarWidth": 240,
      "contentWidth": 1440,
      "spacing": "compact"
    },
    "login": {
      "layout": "reversed",
      "heroTitle": { "zh-CN": "你的云端工作空间", "en": "Your cloud workspace" },
      "heroDescription": "统一管理自己的节点与服务。",
      "loginTitle": "欢迎登录我的控制台",
      "loginSubtitle": "使用你的账号继续",
      "usernameLabel": "邮箱账号",
      "usernamePlaceholder": "请输入注册邮箱",
      "passwordLabel": "账号密码",
      "loginButton": "进入控制台",
      "showArtwork": false,
      "features": ["节点管理", "实时指标", "服务编排"],
      "beforeForm": { "type": "text", "text": "欢迎使用本服务", "variant": "muted" },
      "afterForm": { "type": "text", "text": "如需帮助，请联系网站管理员。" },
      "footer": "My Workspace"
    }
  }
}
```

这是添加到 manifest 的片段，完整主题仍需 `apiVersion`、`id`、`name`、`version`、`stylesheet` 等基础字段。

`shell` 支持：

| 配置 | 可用值 |
| --- | --- |
| `navigation` | `left` / `right`，同时调整侧栏、桌面占位与移动抽屉方向 |
| `sidebarWidth` | 180～400，单位 px，收起宽度仍可通过 CSS 变量调整 |
| `contentWidth` | 640～2560，单位 px，窄屏自动收缩 |
| `spacing` | `compact` / `comfortable`，控制内容区基础留白 |

`login.layout` 为 `split`（默认左右布局）、`reversed`（表单在左）、`centered`（居中单栏）。窄屏继续使用单列表单。`showArtwork`、`showFeatures` 可以隐藏默认插画和特性列表。`features` 可替换为最多六项自己的文字。`hero` 可用下文的节点树完整替换左侧内容区；`beforeForm`、`afterForm` 分别插入表单前后的内容，支持 `site.*` 字段。

可自定义的登录文字：

| 位置 | 配置键 |
| --- | --- |
| 左侧介绍 | `eyebrow`、`heroTitle`、`heroDescription` |
| 登录/注册标题与副标题 | `loginTitle`、`registerTitle`、`loginSubtitle`、`registerSubtitle` |
| 账号与密码 | `usernameLabel`、`usernamePlaceholder`、`passwordLabel`、`passwordPlaceholder` |
| 注册占位文字 | `registerUsernamePlaceholder`、`registerPasswordPlaceholder` |
| 昵称与确认密码 | `nicknameLabel`、`nicknamePlaceholder`、`confirmPasswordLabel`、`confirmPasswordPlaceholder` |
| 验证邮箱 | `emailLabel`、`emailPlaceholder` |
| 按钮与切换链接 | `loginButton`、`registerButton`、`registerLink`、`loginLink` |
| 注册提示、页脚 | `registrationNote`、`footer` |

文字支持字符串或 `{ "zh-CN": "中文", "en": "English" }`；按面板语言选择，没有对应语言时回退到已提供的文字。每项最长 500 字符，空字符串可清除相应文案。全部作为纯文本显示。登录、注册、验证码、两步验证和第三方登录依然使用真实认证表单，配置文案不会关闭验证或改变注册权限。

未登录欢迎首页可继续使用「公开首页 → 使用自定义 H5」独立设计；当前不从主题包加载 HTML。插件、其他业务页面可以使用全局 CSS 标记修改外观，本节的字段模板目前接入登录内容区与主机管理页。

### 主机管理：字段、卡片与整体布局

下面的示例将主机展示为一行一张，每张卡片分为身份区和指标区，并把汇总区放在主机列表后面：

```json
{
  "views": {
    "hosts": {
      "title": "我的节点",
      "defaultView": "card",
      "cardLayout": "rows",
      "gap": 12,
      "sections": ["intro", "groups", "list", "summary", "outro"],
      "intro": {
        "type": "group", "direction": "row",
        "children": [
          { "type": "text", "text": "节点总览", "variant": "title" },
          { "type": "field", "field": "fleet.online", "label": "在线节点", "display": "badge" }
        ]
      },
      "actionsPlacement": "footer",
      "card": {
        "type": "group", "id": "node-layout", "direction": "grid",
        "columns": { "mobile": 1, "tablet": 2, "desktop": 3 }, "gap": 16,
        "children": [
          {
            "type": "group", "id": "identity", "direction": "column",
            "children": [
              { "type": "field", "field": "host.name", "display": "stat", "label": false },
              { "type": "field", "field": "host.address", "label": "连接地址" },
              { "type": "field", "field": "host.online", "display": "badge" }
            ]
          },
          {
            "type": "group", "direction": "column",
            "children": [
              { "type": "field", "field": "host.cpuUsage", "display": "progress" },
              { "type": "field", "field": "host.memoryUsage", "display": "progress" },
              { "type": "field", "field": "host.diskUsage", "display": "progress" }
            ]
          },
          {
            "type": "group", "direction": "column",
            "children": [
              { "type": "field", "field": "host.networkOutSpeed", "label": "当前上传", "display": "stat" },
              { "type": "field", "field": "host.trafficRemaining", "missing": "无限额" },
              { "type": "field", "field": "host.remainingDays", "suffix": " 天", "when": "available" }
            ]
          }
        ]
      }
    }
  }
}
```

删除某个字段节点就不展示该指标；调整 `children` 顺序就改变实际 DOM 与键盘阅读顺序。标签、分组、进度条、信息块可以自行组合，不需要预先保留 CPU/内存等固定区域。

| hosts 配置 | 说明 |
| --- | --- |
| `title` | 主机页标题，支持双语 |
| `defaultView` | `card` / `compact-card` / `table` / `map` / `flat-map`；进入页面或主题版本变化时应用，用户仍可切换视图 |
| `cardLayout` | `grid` 网格 / `rows` 一行一张；用于卡片视图 |
| `columns` | 网格列数，例如 `{ "mobile": 1, "tablet": 2, "desktop": 4 }` |
| `gap` | 卡片间距 0～48px |
| `showSummary` | 是否展示原有三项汇总，默认 true；可用 `intro` 自行组合汇总字段 |
| `sections` | `intro`、`summary`、`groups`、`list`、`outro` 各出现一次，按数组顺序排列 |
| `intro` / `outro` | 列表前后区域的节点树，使用 `fleet.*`、`site.*`、`viewer.*` 字段 |
| `card` | 单台主机卡片节点树，也可使用公共和汇总字段；省略时保留原卡片内容 |
| `actionsPlacement` | 原有主机操作放在 `header` / `footer`，默认 header |

编辑、更多操作、拖动排序、分页、筛选和权限判断由面板继续提供。卡片模板也应用于表格/地图在窄屏上的卡片回退；网格列数只控制正常卡片视图，不强制将窄屏地图或表格变成桌面布局。桌面表格列继续使用页面现有的「列表设置」。

### 节点协议

所有模板共用 `group`、`field`、`text` 三种节点。每个根模板最多 128 个节点、6 层节点深度、每个容器最多 24 个子节点；未知字段、未知属性、重复节点 ID 和超限布局会在安装时拒绝。

| 节点 | 属性 |
| --- | --- |
| `group` | `direction`: `column` / `row` / `grid`；`children`: 节点数组；`gap`: 0～48px；`columns`: 各断点列数 |
| `field` | `field`: 字段目录中的完整键；`label`: 自定义文字或 false；`display`: `text` / `stat` / `badge` / `progress` |
| `field` 格式 | `precision`: 0～3（数值和百分比最大小数位数）；`missing`: 空值文案；`prefix` / `suffix`: 前后缀；`tone`: `default` / `muted` / `success` / `warning` / `danger` |
| `text` | `text`: 纯文本或双语对象；`variant`: `title` / `body` / `muted` |
| 通用 | 可选 `id`（小写字母开头，含数字和短横线，最长 48）；`span`（父网格中的跨列数，1～6）；`when` 为 `always`、`online`、`offline` 或字段节点的 `available` |

`row` 可自动换行；`grid` 的 mobile 为小于 768px，tablet 为 768～1279px，desktop 为 1280px 及以上。未配置的列数沿用前一断点；mobile 默认 1，最大 4 列，其他断点最大 6 列。跨列数自动限制在当前列数以内。更复杂的排版可以在主题 CSS 中针对节点 ID 改写 grid/flex：

```css
@media (min-width: 1280px) {
  [data-theme-node="node-layout"] { grid-template-columns: 1.2fr 1fr 1fr; }
}
[data-theme-node="identity"] [data-theme-part="theme-value"] { font-weight: 600; }
[data-theme-field="host.networkOutSpeed"] [data-theme-part="theme-value"] { color: var(--primary); }
[data-theme-host-card="true"][data-theme-host-status="offline"] { opacity: .75; }
```

所有卡片保留原 `data-theme-part="card"`；`data-theme-host-card="true"` 用来单独选择主机卡片外壳，`data-theme-part="host-card"` 是内部内容区。`data-theme-field` 只包含字段名，字段值通过文本节点展示。

### 字段目录

面板「主题管理 → 字段与布局接口」可以搜索字段并复制字段节点；也可[下载完整字段目录 JSON](/themes/fields.json)，或读取 `themes.capabilities.fields`。以下字段名大小写敏感：

| 类别 | 可用字段 |
| --- | --- |
| 身份与地址 | `host.id`、`host.name`、`host.online`、`host.address`、`host.ipv4`、`host.ipv6` |
| 地区与系统 | `host.region`、`host.countryCode`、`host.os`、`host.cpuModel`、`host.agentVersion` |
| 时间与到期 | `host.lastHeartbeat`、`host.purchasedAt`、`host.expiresAt`、`host.remainingDays`、`host.uptime`、`host.sampledAt` |
| CPU 与负载 | `host.cpuUsage`、`host.load1`、`host.load5`、`host.load15` |
| 内存与 Swap | `host.memoryUsage`、`host.memoryUsed`、`host.memoryTotal`、`host.swapUsage`、`host.swapUsed`、`host.swapTotal` |
| 磁盘 | `host.diskUsage`、`host.diskUsed`、`host.diskTotal` |
| 网络与系统累计 | `host.networkInSpeed`、`host.networkOutSpeed`、`host.systemNetworkIn`、`host.systemNetworkOut` |
| 面板流量计量 | `host.trafficIn`、`host.trafficOut`、`host.trafficUsed`、`host.trafficLimit`、`host.trafficRemaining`、`host.trafficPercent`、`host.trafficMode` |
| 连接数 | `host.tcpConnections`、`host.tcpInUse`、`host.tcpTimeWait`、`host.udpConnections` |
| 主机页汇总 | `fleet.total`、`fleet.online`、`fleet.offline`、`fleet.networkInSpeed`、`fleet.networkOutSpeed`、`fleet.trafficIn`、`fleet.trafficOut` |
| 公共字段 | `site.title`、`site.version`、`viewer.name`、`viewer.role` |

数值格式随字段固定：容量按字节、速率按字节/秒、运行时间按秒、日期原始值为毫秒时间戳、百分比按 0～100 的数值格式化。`progress` 只允许百分比字段，进度条在 0～100 内显示，超额百分比的文字仍保留实际数值。`host.online` 显示本地化在线/离线，`host.trafficMode` 为 `both` / `outbound` / `max`，`viewer.role` 为账号角色标识。主题不能用任意对象路径访问其他数据。

字段由现有的鉴权查询提供，不增加逐卡片请求，不会向未登录页公开真实主机数据。未上报的值为 null，显示 `—` 或 `missing`；有效的 0 正常显示。离线主机的实时指标不可用，历史资产信息和已知累计流量仍可显示；连接数在离线、采样失败或超过 15 分钟时不可用。`trafficLimit=0` 表示无限额，此时 `trafficPercent`、`trafficRemaining` 为 null。到期日未设置时 `remainingDays` 为 null，已到期为 0。已用流量遵循主机的双向、仅出向或取最大值设置。

`fleet.*` 取当前账号和当前筛选范围的汇总，`viewer.*` 只代表当前登录用户，在未登录的登录页为空；`site.*` 可用于登录内容。分页未加载的主机不会偷偷发起额外查询。安全模式同时停用自定义 CSS、布局、文案和字段模板，恢复默认界面。

## CSS 与布局接口

根元素始终提供以下属性：

```css
html[data-theme-api="1"][data-forwardx-theme="my-aurora-theme"] { }
html.dark[data-forwardx-theme="my-aurora-theme"] { }
```

版本化的 `data-theme-part` 用于选择界面区域，优先使用这些属性，避免依赖 Tailwind 工具类或不稳定的页面内部结构。

| 属性值 | 区域 |
| --- | --- |
| `shell` | 后台整体容器 |
| `sidebar` | 桌面和移动侧栏容器 |
| `workspace` | 侧栏之外的工作区 |
| `header` | 后台顶部栏 |
| `content` | 当前业务页面内容容器 |
| `card` | 公共 Card 组件 |
| `button` | 公共 Button 组件 |
| `input` | 公共 Input 组件 |
| `table` | 公共 Table 组件 |
| `dialog` | 公共 Dialog 内容，包含 Portal 弹窗 |
| `login` | 登录页面整体布局 |
| `login-header` / `login-hero` / `login-form` / `login-footer` | 登录页品牌栏、介绍区、表单容器、页脚 |
| `login-before` / `login-after` | 登录表单前后内容 |
| `hosts` / `hosts-toolbar` / `hosts-page` | 主机管理整页、工具栏、主机标签页 |
| `hosts-intro` / `hosts-summary` / `hosts-groups` / `hosts-list` / `hosts-outro` | 主机页可排列区域 |
| `host-grid` / `host-card` / `host-actions` | 主机卡片网格、卡片内部内容、主题卡片操作栏 |
| `theme-group` / `theme-field` / `theme-label` / `theme-value` / `theme-text` | 声明式节点容器、字段、标签、数值、文字 |

`card`、`button` 等标记覆盖使用公共组件的界面；插件独立页面、图表 Canvas 和业务自绘内容不保证具备全部标记。侧栏收起与移动端开关继续由面板管理，主题需保留这些状态下的可操作性。

```css
/* 字体和图片必须随主题包提供，路径相对于 CSS 文件 */
@font-face {
  font-family: Workspace;
  src: url("assets/interface.woff2") format("woff2");
  font-display: swap;
}
body { font-family: Workspace, system-ui, sans-serif; }

[data-theme-part="card"] { border-radius: 12px; box-shadow: 0 4px 20px #00000008; }
[data-theme-part="header"] { background: var(--card); }
[data-theme-part="button"] { border-radius: 8px; }

@media (min-width: 1024px) {
  [data-theme-part="content"] { max-width: 1600px; width: 100%; margin-inline: auto; }
}

html.dark [data-theme-part="sidebar"] { border-color: #314b4b; }
```

此示例的图片和字体需要自行添加；不使用这些资源时删除对应的 URL 声明。资源引用在安装时转换为内嵌数据，不依赖额外的静态资源路径。支持 `@media`、`@supports`、`@container`、`@layer`、`@keyframes`、`@font-face`、`@property`、`@starting-style`；不支持 `@import`、远程 URL、已有 data URL、CSS 标识符转义或 `expression()`、`image-set()`、`paint()` 等函数。将所有样式合并为一个入口 CSS，不通过主题发起网络请求。

常用变量：

| 用途 | 变量 |
| --- | --- |
| 页面、正文 | `--background`、`--foreground` |
| 卡片、浮层 | `--card`、`--card-foreground`、`--popover`、`--popover-foreground` |
| 主色与强调 | `--primary`、`--primary-foreground`、`--accent`、`--accent-foreground`、`--ring` |
| 次级、弱化、错误 | `--secondary`、`--secondary-foreground`、`--muted`、`--muted-foreground`、`--destructive`、`--destructive-foreground` |
| 输入和边框 | `--input`、`--border` |
| 图表 | `--chart-1` 至 `--chart-5` |
| 侧栏 | `--sidebar`、`--sidebar-foreground`、`--sidebar-accent`、`--sidebar-accent-foreground`、`--sidebar-primary`、`--sidebar-primary-foreground`、`--sidebar-border`、`--sidebar-ring` |
| 侧栏尺寸 | `--theme-sidebar-width`、`--theme-sidebar-icon-width`、`--forwardx-mobile-sidebar-width` |
| 公共圆角、字体 | `--radius`、`--font-sans` |
| 玻璃材质 | `--pearl-surface`、`--pearl-glass`、`--pearl-glow`、`--pearl-header-height` |

每次主题切换会移除上一主题的变量和 CSS。开发时在测试面板应用主题，并检查浅色、深色、桌面、移动、侧栏收起、弹窗、表格滚动和减少动态效果设置下的实际效果。

## 开发接口

接口使用面板现有的 tRPC v11 + SuperJSON，基础路径为 `/api/trpc`。管理接口需要**已登录的管理员会话**，普通用户无权上传、导入或切换全站主题；不能使用主题包来获取管理权限。只有当前启用主题的样式接口允许公开访问，以便登录页加载主题。

| 方法 | tRPC 路径 | 输入 | 返回 |
| --- | --- | --- | --- |
| GET | `themes.capabilities` | 无 | `apiVersion`、`formats`、`limits`、`parts`、`documentation` |
| GET | `themes.list` | 无 | `{ active: ThemeSummary, themes: ThemeSummary[] }`，含内置主题 |
| GET | `themes.template` | `{ base?: "teal" }` | `{ filename, archiveBase64 }`，`base` 可用六个内置 ID |
| POST | `themes.install` | `{ archiveBase64, replace?: false }` | 安装后 `ThemeSummary`，不启用；Base64 不带 data URL 前缀 |
| POST | `themes.importUrl` | `{ url, replace?: false }` | 下载并安装后的 `ThemeSummary`，不启用 |
| POST | `themes.activate` | `{ id }` | 应用后的 `ThemeSummary`，支持内置或自定义 ID |
| POST | `themes.remove` | `{ id }` | `{ success: true }` |
| GET | `themes.styles` | `{ id, revision }` | 当前启用的自定义主题 `ThemeDefinition`；其他主题/旧 revision 返回 NOT_FOUND |
| GET | `system.publicInfo` | 无 | 原字段外新增 `activeTheme: ThemeSummary`，不含安装包或完整 CSS |

```ts
type ThemeSummary = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  base: "ink" | "teal" | "forest" | "wisteria" | "ember" | "sakura";
  builtin: boolean;
  revision: string; // 自定义主题为 SHA-256，内置为 builtin-v1
};
type ThemeDefinition = {
  manifest: ThemeManifest; // 上文 theme.json 结构
  css: string;            // 资源已内嵌的 CSS
  revision: string;
};
```

原有 `system.updateSettings({ personalizationTheme: "teal" })` 保持兼容，会切换到对应内置主题，并停用当前自定义主题。`system.publicInfo.personalizationTheme` 保留为基础配色 ID，新客户端应同时读取 `activeTheme`。

### JavaScript 客户端示例

在已登录管理员的面板页面控制台，或同源开发页面中执行。会话只发送给当前面板；不要把 Cookie、Token 或管理凭据写进主题压缩包。

```js
async function themeRpc(procedure, input, mutation = false) {
  const payload = { json: input ?? null };
  const url = "/api/trpc/" + procedure;
  const response = await fetch(
    mutation ? url : url + "?input=" + encodeURIComponent(JSON.stringify(payload)),
    {
      method: mutation ? "POST" : "GET",
      credentials: "same-origin",
      headers: mutation ? { "Content-Type": "application/json" } : undefined,
      body: mutation ? JSON.stringify(payload) : undefined
    }
  );
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(body.error?.json?.message || "Theme request failed");
  }
  return body.result.data.json;
}

const capabilities = await themeRpc("themes.capabilities");
console.log(capabilities.formats); // zip, rar, tar, tar.gz, tgz

// 导入具体的压缩包直链；下载/安装完成后再应用
const installed = await themeRpc("themes.importUrl", {
  url: "https://downloads.example.com/themes/aurora.rar",
  replace: false
}, true);
await themeRpc("themes.activate", { id: installed.id }, true);

// 恢复默认主题
await themeRpc("themes.activate", { id: "ink" }, true);
```

如果已经使用项目中的 tRPC 客户端，可直接调用 `trpc.themes.install.mutate(...)`、`trpc.themes.importUrl.mutate(...)` 等，无需自行封装传输。上传前用 `FileReader.readAsDataURL(file)` 读取，再去掉第一个逗号及其前缀，作为 `archiveBase64`。

常见错误：未登录为 `UNAUTHORIZED`；非管理员为 `FORBIDDEN`；重复 ID、替换或删除正在使用的主题为 `CONFLICT`；主题不存在或样式 revision 过期为 `NOT_FOUND`；压缩包、manifest、CSS、大小或下载校验失败为 `BAD_REQUEST`。接口不根据 `version` 自动升级，明确的 `replace: true` 才表示替换授权。

项目内开发可运行 `pnpm test:themes` 验证主题包、RAR/TAR/ZIP 解析、字段白名单与布局校验、渲染与文本转义、远程导入边界、管理权限及明暗切换清理；`pnpm themes:package` 生成教程中的示例下载包和字段目录。接口结构见 `shared/themes.ts`、`shared/themeViews.ts`、`shared/themeFields.ts`、`server/routers/themes.ts`，CSS 校验实现见 `server/themePackage.ts`。
