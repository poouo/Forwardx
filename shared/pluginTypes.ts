export const PLUGIN_MENU_KEY = "plugins" as const;
export const PLUGIN_MANIFEST_VERSION = 1 as const;

export const PLUGIN_PERMISSION_KEYS = [
  "read:system",
  "read:hosts",
  "read:rules",
  "write:rules",
  "read:tunnels",
  "read:traffic",
  "write:settings",
  "net:http",
  "agent:execute",
  "data:whitelist",
  "ui:page",
  "ui:settings",
  "event:subscribe",
] as const;

export type PluginPermissionKey = typeof PLUGIN_PERMISSION_KEYS[number];

export const PLUGIN_EXTENSION_POINTS = [
  "settings.panel",
  "sidebar.page",
  "dashboard.card",
  "rule.action",
  "host.action",
  "event.handler",
  "data.whitelist",
] as const;

export type PluginExtensionPoint = typeof PLUGIN_EXTENSION_POINTS[number];

export const PLUGIN_SETTING_FIELD_TYPES = [
  "text",
  "textarea",
  "password",
  "number",
  "boolean",
  "select",
  "url",
] as const;

export type PluginSettingFieldType = typeof PLUGIN_SETTING_FIELD_TYPES[number];

export const PLUGIN_PAGE_CONTENT_TYPES = ["markdown", "html", "text"] as const;
export type PluginPageContentType = typeof PLUGIN_PAGE_CONTENT_TYPES[number];

export const PLUGIN_ACTION_TYPES = [
  "noop",
  "http.request",
  "agent.request",
  "data.asset.refresh",
  "data.whitelist.refresh",
] as const;

export type PluginActionType = typeof PLUGIN_ACTION_TYPES[number];

export const PLUGIN_HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

export type PluginHttpMethod = typeof PLUGIN_HTTP_METHODS[number];

export const PLUGIN_HTTP_RESPONSE_TYPES = [
  "auto",
  "json",
  "text",
] as const;

export type PluginHttpResponseType = typeof PLUGIN_HTTP_RESPONSE_TYPES[number];

export const PLUGIN_HTTP_AUTH_TYPES = [
  "none",
  "bearer",
  "header",
  "cookie",
] as const;

export type PluginHttpAuthType = typeof PLUGIN_HTTP_AUTH_TYPES[number];

export const PLUGIN_AGENT_EXECUTORS = ["script"] as const;
export type PluginAgentExecutor = typeof PLUGIN_AGENT_EXECUTORS[number];

export const PLUGIN_AGENT_INTERPRETERS = ["bash", "sh", "python3"] as const;
export type PluginAgentInterpreter = typeof PLUGIN_AGENT_INTERPRETERS[number];

export const PLUGIN_AGENT_OUTPUT_TYPES = ["json", "text"] as const;
export type PluginAgentOutputType = typeof PLUGIN_AGENT_OUTPUT_TYPES[number];

export const PLUGIN_AGENT_TARGETS = ["usage-hosts"] as const;
export type PluginAgentTarget = typeof PLUGIN_AGENT_TARGETS[number];

export const PLUGIN_USAGE_VIEW_TYPES = [
  "host-asset-sync",
] as const;

export type PluginUsageViewType = typeof PLUGIN_USAGE_VIEW_TYPES[number];

export const PLUGIN_USAGE_FIELD_TYPES = [
  "text",
  "textarea",
  "boolean",
  "select",
  "multi-select",
] as const;

export type PluginUsageFieldType = typeof PLUGIN_USAGE_FIELD_TYPES[number];

export type PluginSettingOption = {
  label: string;
  value: string;
};

export type PluginSettingField = {
  key: string;
  label: string;
  type: PluginSettingFieldType;
  description?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
  min?: number;
  max?: number;
  options?: PluginSettingOption[];
};

export type PluginPageDefinition = {
  id: string;
  title: string;
  description?: string;
  contentType?: PluginPageContentType;
  content?: string;
  assetPath?: string;
};

export type PluginHttpAuthDefinition = {
  type?: PluginHttpAuthType;
  token?: string;
  header?: string;
  value?: string;
  cookieName?: string;
  cookieValue?: string;
};

export type PluginHttpRequestDefinition = {
  method: PluginHttpMethod;
  url?: string;
  baseUrlSetting?: string;
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  responseType?: PluginHttpResponseType;
  auth?: PluginHttpAuthDefinition;
};

export type PluginAgentRequestDefinition = {
  executor: PluginAgentExecutor;
  interpreter?: PluginAgentInterpreter;
  target?: PluginAgentTarget;
  usageViewId?: string;
  entry: string;
  arguments?: string[];
  timeoutMs?: number;
  outputType?: PluginAgentOutputType;
};

export type PluginActionDefinition = {
  id: string;
  label: string;
  type: PluginActionType;
  description?: string;
  confirmRequired?: boolean;
  inputSchema?: PluginSettingField[];
  request?: PluginHttpRequestDefinition;
  agent?: PluginAgentRequestDefinition;
};

export type PluginAssetDeclaration = {
  path: string;
  label?: string;
  description?: string;
  contentType?: string;
  maxBytes?: number;
};

export type PluginFeatureDescription = {
  title: string;
  description?: string;
};

export type PluginUsageSelectorCopy = {
  title?: string;
  description?: string;
  selectedLabel?: string;
  emptyText?: string;
  selectAllLabel?: string;
  clearLabel?: string;
  hidden?: boolean;
};

export type PluginUsageNoteField = {
  label?: string;
  placeholder?: string;
};

export type PluginUsageFooter = {
  title?: string;
  description?: string;
  submitLabel?: string;
};

export type PluginUsageOperationOption = {
  label: string;
  value: string;
  description?: string;
};

export type PluginUsageOperationSelector = {
  label?: string;
  description?: string;
  defaultValue?: string;
  options?: PluginUsageOperationOption[];
};

export type PluginUsageFieldDefinition = {
  key: string;
  label: string;
  type: PluginUsageFieldType;
  description?: string;
  placeholder?: string;
  defaultValue?: string | boolean | string[];
  options?: PluginSettingOption[];
  required?: boolean;
};

export type PluginUsageViewDefinition = {
  id: string;
  type: PluginUsageViewType;
  title: string;
  description?: string;
  storageKey?: string;
  enableLabel?: string;
  targetDirectory?: string;
  assetMode?: "selected-assets" | "all-plugin-assets";
  preserveAssetPaths?: boolean;
  disabledTitle?: string;
  disabledDescription?: string;
  hostSelector?: PluginUsageSelectorCopy;
  assetSelector?: PluginUsageSelectorCopy;
  operationSelector?: PluginUsageOperationSelector;
  fields?: PluginUsageFieldDefinition[];
  noteField?: PluginUsageNoteField;
  footer?: PluginUsageFooter;
};

export type ForwardxPluginManifest = {
  schemaVersion?: typeof PLUGIN_MANIFEST_VERSION;
  id: string;
  name: string;
  version: string;
  description?: string;
  detailsMarkdown?: string;
  features?: PluginFeatureDescription[];
  author?: string;
  logo?: string;
  releaseDate?: string;
  updatedAt?: string;
  changelog?: string;
  tags?: string[];
  license?: string;
  homepage?: string;
  repository?: string;
  minPanelVersion?: string;
  permissions?: PluginPermissionKey[];
  extensionPoints?: PluginExtensionPoint[];
  settingsSchema?: PluginSettingField[];
  pages?: PluginPageDefinition[];
  actions?: PluginActionDefinition[];
  usageViews?: PluginUsageViewDefinition[];
  assets?: PluginAssetDeclaration[];
  data?: {
    type?: "generic";
    repository?: string;
    branch?: string;
    autoDiscover?: boolean;
    files?: string[];
  };
  settingsValues?: Record<string, unknown>;
};

export type PluginStoreItem = {
  id: string;
  name: string;
  description: string;
  detailsMarkdown?: string;
  features?: PluginFeatureDescription[];
  version?: string;
  releaseDate?: string;
  updatedAt?: string;
  changelog?: string;
  tags?: string[];
  license?: string;
  repository: string;
  branch?: string;
  manifestPath?: string;
  homepage?: string;
  author?: string;
  logo?: string;
  packageRepository?: string;
  packageBranch?: string;
  packageUrl?: string;
  packagePath?: string;
  bundledPath?: string;
  category: "data" | "integration" | "ui" | "automation";
  permissions: PluginPermissionKey[];
  extensionPoints: PluginExtensionPoint[];
  official?: boolean;
  builtIn?: boolean;
};

export const BUILTIN_PLUGIN_STORE_ITEMS: PluginStoreItem[] = [
  {
    id: "china-region-whitelist",
    name: "ForwardX 中国区域白名单",
    description: "为 ForwardX 面板适配的中国区域白名单插件，可在插件内选择主机并下发白名单防火墙配置。",
    detailsMarkdown: [
      "ForwardX 中国区域白名单插件用于把中国大陆全国、省级 CIDR 和 ASN 白名单规则下发到选中的 Agent 主机。",
      "",
      "安装后进入“插件使用”，选择主机、执行方式和白名单范围即可。默认只同步脚本、数据和配置，不会直接修改防火墙；需要正式生效时再选择“应用规则”。",
      "",
      "- 支持全国或按省份选择全局入站白名单。",
      "- 支持额外 ASN 和端口优先白名单。",
      "- 支持 nftables 或 iptables/ipset。",
      "- 支持状态查看、规则预演、应用规则、清理规则和更新 ASN。",
    ].join("\n"),
    version: "0.3.1",
    releaseDate: "2026-07-11",
    updatedAt: "2026-07-11",
    changelog: "修复全国与省份同时选择时省级白名单被全国 CIDR 覆盖的问题，并优化主机规则状态展示。",
    features: [
      { title: "区域白名单", description: "支持全国 CN 或按省份选择入站白名单。" },
      { title: "端口策略", description: "支持为指定端口或端口范围设置独立白名单。" },
      { title: "Agent 下发", description: "面板生成配置后由 Agent 同步脚本、数据和规则操作。" },
      { title: "规则预演", description: "应用前可以先输出将执行的 nftables/iptables 命令。" },
    ],
    logo: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMTAiIHkxPSI4IiB4Mj0iNTYiIHkyPSI1OCI+PHN0b3Agc3RvcC1jb2xvcj0iIzM0ZDM5OSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzBmNzY2ZSIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgcng9IjE4IiBmaWxsPSIjZWNmZWZmIi8+PHBhdGggZD0iTTMyIDggNTAgMTZ2MTRjMCAxMi41LTcuNCAyMC44LTE4IDI2LTEwLjYtNS4yLTE4LTEzLjUtMTgtMjZWMTZsMTgtOFoiIGZpbGw9InVybCgjZykiLz48cGF0aCBkPSJNMjMgMzRoOHYtOGgxMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjIzIiBjeT0iMzQiIHI9IjQiIGZpbGw9IiNmZmYiLz48Y2lyY2xlIGN4PSIzMSIgY3k9IjI2IiByPSI0IiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iNDEiIGN5PSIyNiIgcj0iNCIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==",
    tags: ["whitelist", "china-region", "firewall", "agent"],
    license: "Unknown",
    repository: "https://github.com/poouo/Forwardx",
    branch: "main",
    manifestPath: "plugins/china-region-whitelist/forwardx-plugin.json",
    homepage: "https://github.com/poouo/Forwardx",
    author: "poouo",
    packageRepository: "https://github.com/poouo/Forwardx",
    packageBranch: "main",
    packagePath: "plugins/packages/china-region-whitelist.tar.gz",
    bundledPath: "plugins/china-region-whitelist",
    category: "data",
    permissions: ["data:whitelist", "agent:execute"],
    extensionPoints: ["data.whitelist"],
    official: true,
    builtIn: true,
  },
];

export const DEFAULT_PLUGIN_MANIFEST: Pick<ForwardxPluginManifest, "permissions" | "extensionPoints"> = {
  permissions: [],
  extensionPoints: [],
};

export const PLUGIN_SECURITY_MODEL = {
  remoteCodeExecution: false,
  agentPackagedScriptExecution: true,
  uploadPackageType: "json|zip|tar.gz",
  maxUploadBytes: 1024 * 1024,
  maxAssetBytes: 512 * 1024,
  maxPackageBytes: 5 * 1024 * 1024,
  maxHttpResponseBytes: 256 * 1024,
  description: "ForwardX 插件由面板解释 manifest。普通插件不执行面板后端代码；声明 net:http 后可发起受控 HTTP 请求；声明 agent:execute 后可让 Agent 在独立任务队列中执行插件包内固定脚本入口，并限制目录、参数、超时和输出大小。",
} as const;
