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
    version: "0.2.0",
    releaseDate: "2026-07-10",
    updatedAt: "2026-07-10",
    changelog: "补齐白名单脚本能力，支持主机配置生成、预演、应用、状态查看、清理规则和完整数据下发。",
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
  description: "ForwardX 插件由面板解释 manifest。普通插件不执行后端代码；内置受控插件可以通过声明式使用页向 Agent 下发白名单内的脚本和数据。",
} as const;
