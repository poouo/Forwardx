export const PLUGIN_MENU_KEY = "plugins" as const;
export const PLUGIN_MANIFEST_VERSION = 1 as const;

export const PLUGIN_PERMISSION_KEYS = [
  "read:system",
  "read:users",
  "write:users",
  "read:hosts",
  "write:hosts",
  "read:rules",
  "write:rules",
  "read:tunnels",
  "write:tunnels",
  "read:forward-groups",
  "write:forward-groups",
  "read:traffic",
  "telegram:send",
  "write:settings",
  "net:http",
  "agent:read",
  "agent:write",
  "agent:execute",
  "secret:reveal",
  "ui:interactive",
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

export const PLUGIN_SIDEBAR_TARGETS = ["usage", "settings", "page"] as const;
export type PluginSidebarTarget = typeof PLUGIN_SIDEBAR_TARGETS[number];

export const PLUGIN_ACTION_TYPES = [
  "noop",
  "http.request",
  "agent.request",
  "panel.request",
  "data.asset.refresh",
  "data.whitelist.refresh",
] as const;

export type PluginActionType = typeof PLUGIN_ACTION_TYPES[number];

export const PLUGIN_PANEL_OPERATIONS = [
  "system.summary",
  "users.list",
  "users.get",
  "users.create",
  "users.updateAccount",
  "users.updateLimits",
  "users.setAccountEnabled",
  "users.setForwardAccess",
  "users.delete",
  "users.permissions.get",
  "users.permissions.set",
  "hosts.list",
  "hosts.get",
  "hosts.create",
  "hosts.update",
  "hosts.delete",
  "rules.list",
  "rules.get",
  "rules.create",
  "rules.update",
  "rules.toggle",
  "rules.delete",
  "tunnels.list",
  "tunnels.get",
  "tunnels.create",
  "tunnels.update",
  "tunnels.delete",
  "tunnels.test",
  "forwardGroups.list",
  "forwardGroups.get",
  "forwardGroups.create",
  "forwardGroups.update",
  "forwardGroups.delete",
  "forwardGroups.sync",
  "forwardGroups.test",
  "traffic.summary",
  "telegram.send",
] as const;

export type PluginPanelOperation = typeof PLUGIN_PANEL_OPERATIONS[number];

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

export const PLUGIN_AGENT_TARGETS = ["usage-hosts", "selected-hosts"] as const;
export type PluginAgentTarget = typeof PLUGIN_AGENT_TARGETS[number];

export const PLUGIN_ACTION_INTENTS = ["read", "write", "execute"] as const;
export type PluginActionIntent = typeof PLUGIN_ACTION_INTENTS[number];

export const PLUGIN_RESOURCE_VIEW_TYPES = ["agent-resource"] as const;
export type PluginResourceViewType = typeof PLUGIN_RESOURCE_VIEW_TYPES[number];

export const PLUGIN_RESOURCE_SOURCE_TRIGGERS = ["onOpen", "onHostSelected", "manual"] as const;
export type PluginResourceSourceTrigger = typeof PLUGIN_RESOURCE_SOURCE_TRIGGERS[number];

export const PLUGIN_RESOURCE_COLUMN_TYPES = [
  "text",
  "number",
  "boolean",
  "status",
  "secret",
  "code",
  "datetime",
] as const;
export type PluginResourceColumnType = typeof PLUGIN_RESOURCE_COLUMN_TYPES[number];

export const PLUGIN_RESOURCE_FIELD_TYPES = [
  "text",
  "textarea",
  "password",
  "number",
  "boolean",
  "select",
  "multi-select",
] as const;
export type PluginResourceFieldType = typeof PLUGIN_RESOURCE_FIELD_TYPES[number];

export const PLUGIN_RESOURCE_CONDITION_OPERATORS = [
  "eq",
  "neq",
  "in",
  "not-in",
  "truthy",
  "falsy",
] as const;
export type PluginResourceConditionOperator = typeof PLUGIN_RESOURCE_CONDITION_OPERATORS[number];

export const PLUGIN_RESULT_SCHEMA_TYPES = ["keyValue", "table"] as const;
export type PluginResultSchemaType = typeof PLUGIN_RESULT_SCHEMA_TYPES[number];

export const PLUGIN_RESULT_FIELD_TYPES = [
  "text",
  "number",
  "boolean",
  "statusBadge",
  "code",
  "datetime",
] as const;
export type PluginResultFieldType = typeof PLUGIN_RESULT_FIELD_TYPES[number];

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
  exclusive?: boolean;
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

export type PluginSidebarDefinition = {
  label?: string;
  icon?: string;
  target?: PluginSidebarTarget;
  pageId?: string;
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

export type PluginPanelRequestDefinition = {
  operation: PluginPanelOperation;
};

export type PluginActionDefinition = {
  id: string;
  label: string;
  type: PluginActionType;
  description?: string;
  confirmRequired?: boolean;
  intent?: PluginActionIntent;
  inputSchema?: PluginSettingField[];
  request?: PluginHttpRequestDefinition;
  agent?: PluginAgentRequestDefinition;
  panel?: PluginPanelRequestDefinition;
  resultSchema?: PluginResultSchemaDefinition;
};

export type PluginResultFieldDefinition = {
  key: string;
  label: string;
  path?: string;
  type?: PluginResultFieldType;
  copyable?: boolean;
  secret?: boolean;
  revealable?: boolean;
  openable?: boolean;
  trueLabel?: string;
  falseLabel?: string;
};

export type PluginResultSchemaDefinition = {
  type: PluginResultSchemaType;
  resultPath?: string;
  itemsPath?: string;
  emptyText?: string;
  fields: PluginResultFieldDefinition[];
};

export type PluginResourceCondition = {
  field: string;
  operator?: PluginResourceConditionOperator;
  value?: unknown;
};

export type PluginResourceOptionsSource = {
  sourceId: string;
  path?: string;
  valueKey?: string;
  labelKey?: string;
  disabledKey?: string;
};

export type PluginResourceFieldDefinition = {
  key: string;
  label: string;
  type: PluginResourceFieldType;
  description?: string;
  placeholder?: string;
  required?: boolean;
  readOnly?: boolean;
  secret?: boolean;
  defaultValue?: string | number | boolean | string[];
  min?: number;
  max?: number;
  options?: PluginSettingOption[];
  optionsSource?: PluginResourceOptionsSource;
  visibleWhen?: PluginResourceCondition[];
  disabledWhen?: PluginResourceCondition[];
};

export type PluginResourceColumnDefinition = {
  key: string;
  label: string;
  type?: PluginResourceColumnType;
  path?: string;
  width?: number;
  copyable?: boolean;
  secret?: boolean;
  trueLabel?: string;
  falseLabel?: string;
};

export type PluginResourceDataSourceDefinition = {
  id: string;
  actionId: string;
  triggers?: PluginResourceSourceTrigger[];
  resultPath?: string;
  itemsPath?: string;
  selectionInputKey?: string;
  selectionValuePath?: string;
  cacheTtlMs?: number;
};

export type PluginResourceOperationDefinition = {
  actionId: string;
  label?: string;
  description?: string;
  confirmRequired?: boolean;
  refreshSources?: string[];
  refreshAfter?: string[];
};

export type PluginResourceViewDefinition = {
  id: string;
  type: PluginResourceViewType;
  title: string;
  description?: string;
  usageViewId?: string;
  rowKey?: string;
  idInputKey?: string;
  listSourceId: string;
  detailSourceId?: string;
  emptyText?: string;
  sources: PluginResourceDataSourceDefinition[];
  columns?: PluginResourceColumnDefinition[];
  fields?: PluginResourceFieldDefinition[];
  operations?: {
    create?: PluginResourceOperationDefinition;
    update?: PluginResourceOperationDefinition;
    delete?: PluginResourceOperationDefinition;
    execute?: PluginResourceOperationDefinition[];
  };
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
  hostScope?: "selected" | "all";
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
  sidebar?: PluginSidebarDefinition;
  actions?: PluginActionDefinition[];
  usageViews?: PluginUsageViewDefinition[];
  resourceSchema?: PluginResourceViewDefinition | PluginResourceViewDefinition[];
  resourceSchemas?: PluginResourceViewDefinition[];
  resourceViews?: PluginResourceViewDefinition[];
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
  storeSourceId?: number;
  storeSourceName?: string;
};

export type PluginStoreSource = {
  id: number;
  name: string;
  repository: string;
  branch: string;
  catalogPath: string;
  pluginCount: number;
  lastSyncedAt?: Date | string | null;
  lastError?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

export const BUILTIN_PLUGIN_STORE_ITEMS: PluginStoreItem[] = [
  {
    id: "china-region-whitelist",
    name: "ForwardX 中国区域白名单",
    description: "按主机实时管理中国大陆全国、省级 CIDR 和 ASN 白名单规则。",
    detailsMarkdown: [
      "ForwardX 中国区域白名单插件用于把中国大陆全国、省级 CIDR 和 ASN 白名单规则应用到 Agent 主机。",
      "",
      "启用后，插件程序和数据会自动同步到所有 Agent。左侧展示全部主机并支持筛选；点击主机后，可在右侧新增、查看、修改、删除和刷新实际白名单规则。",
      "",
      "- 支持全国或按省份选择全局入站白名单。",
      "- 支持额外 ASN 和端口优先白名单。",
      "- 支持 nftables 或 iptables/ipset。",
      "- 支持按 Agent 独立管理配置并实时查看应用和失败状态。",
    ].join("\n"),
    version: "0.6.1",
    releaseDate: "2026-07-17",
    updatedAt: "2026-07-17",
    changelog: "增加可选的左侧菜单入口，可直接打开白名单配置界面。",
    features: [
      { title: "区域白名单", description: "支持全国 CN 或按省份选择入站白名单。" },
      { title: "端口策略", description: "支持为指定端口或端口范围设置独立白名单。" },
      { title: "Agent 管理", description: "按 Agent 实时读取、编辑、应用和清理独立配置。" },
      { title: "实时状态", description: "展示防火墙后端、规则数量、持久化状态和执行错误。" },
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
    permissions: ["data:whitelist", "read:hosts", "agent:read", "agent:write", "ui:interactive", "ui:page"],
    extensionPoints: ["data.whitelist", "sidebar.page"],
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
  description: "ForwardX 插件由面板解释 manifest。普通插件不执行面板后端代码；声明 net:http 后可发起受控 HTTP 请求；声明 Agent 权限后可在独立任务队列中执行插件包内固定脚本入口。panel.request 仅允许管理员已设为信任且声明对应细分权限的插件调用固定面板操作，不支持任意路由、SQL 或后端代码执行。",
} as const;
