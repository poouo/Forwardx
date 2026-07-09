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
  "data.asset.refresh",
  "data.whitelist.refresh",
] as const;

export type PluginActionType = typeof PLUGIN_ACTION_TYPES[number];

export const PLUGIN_USAGE_VIEW_TYPES = [
  "host-asset-sync",
] as const;

export type PluginUsageViewType = typeof PLUGIN_USAGE_VIEW_TYPES[number];

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

export type PluginActionDefinition = {
  id: string;
  label: string;
  type: PluginActionType;
  description?: string;
  confirmRequired?: boolean;
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

export type PluginUsageViewDefinition = {
  id: string;
  type: PluginUsageViewType;
  title: string;
  description?: string;
  storageKey?: string;
  enableLabel?: string;
  targetDirectory?: string;
  disabledTitle?: string;
  disabledDescription?: string;
  hostSelector?: PluginUsageSelectorCopy;
  assetSelector?: PluginUsageSelectorCopy;
  noteField?: PluginUsageNoteField;
  footer?: PluginUsageFooter;
};

export type ForwardxPluginManifest = {
  schemaVersion?: typeof PLUGIN_MANIFEST_VERSION;
  id: string;
  name: string;
  version: string;
  description?: string;
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
    type?: "china-region-whitelist" | "generic";
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
    description: "为 ForwardX 面板适配的中国区域白名单数据插件，可选择主机并同步到 Agent 本地。",
    version: "0.1.0",
    releaseDate: "2026-07-09",
    updatedAt: "2026-07-09",
    changelog: "提供 ForwardX 内置中国区域白名单数据，并支持在插件内选择主机生效。",
    features: [
      { title: "白名单数据", description: "提供面板内置维护的中国区域 IP、域名、云服务和区域标识数据。" },
      { title: "在线刷新", description: "安装后可从 ForwardX 内置插件目录刷新数据资产。" },
      { title: "本地下载", description: "同步后的文件可在插件资产中预览和下载。" },
      { title: "主机同步", description: "使用页由插件声明，面板按声明渲染主机和数据文件选择。" },
    ],
    logo: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMTAiIHkxPSI4IiB4Mj0iNTYiIHkyPSI1OCI+PHN0b3Agc3RvcC1jb2xvcj0iIzM0ZDM5OSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzBmNzY2ZSIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgcng9IjE4IiBmaWxsPSIjZWNmZWZmIi8+PHBhdGggZD0iTTMyIDggNTAgMTZ2MTRjMCAxMi41LTcuNCAyMC44LTE4IDI2LTEwLjYtNS4yLTE4LTEzLjUtMTgtMjZWMTZsMTgtOFoiIGZpbGw9InVybCgjZykiLz48cGF0aCBkPSJNMjMgMzRoOHYtOGgxMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjIzIiBjeT0iMzQiIHI9IjQiIGZpbGw9IiNmZmYiLz48Y2lyY2xlIGN4PSIzMSIgY3k9IjI2IiByPSI0IiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iNDEiIGN5PSIyNiIgcj0iNCIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==",
    tags: ["whitelist", "china-region", "data"],
    license: "Unknown",
    repository: "https://github.com/poouo/Forwardx",
    branch: "main",
    manifestPath: "plugins/china-region-whitelist/forwardx-plugin.json",
    homepage: "https://github.com/poouo/Forwardx",
    author: "poouo",
    packageRepository: "https://github.com/poouo/Forwardx",
    packageBranch: "main",
    category: "data",
    permissions: ["data:whitelist"],
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
  uploadPackageType: "json|zip|tar.gz",
  maxUploadBytes: 1024 * 1024,
  maxAssetBytes: 512 * 1024,
  maxPackageBytes: 5 * 1024 * 1024,
  description: "ForwardX 插件第一版只解释 manifest、设置项、页面和数据资产，不执行第三方脚本、Shell 或后端代码。",
} as const;
