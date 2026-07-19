import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  buildPluginDirectorySwapCommand,
  buildPluginTextFileCommands,
  normalizePluginManifest,
  normalizePluginStoreCatalog,
  pluginManifestRequiresTrust,
  pluginVersionHasUpdate,
  resolvePluginSidebarEntry,
  resolvePluginUsageHostIds,
  shouldPreservePluginTrust,
} from "./repositories/pluginRepository";

test("plugin sync commands compress, chunk, and restore large text assets", () => {
  const content = Array.from({ length: 12_000 }, (_, index) => `192.0.2.${index % 255}/32 region-${index % 32}`).join("\n");
  const commands = buildPluginTextFileCommands("/var/lib/forwardx-agent/plugins/demo/data/regions.txt", content);
  const encoded = commands.flatMap((command) => {
    const match = command.match(/^printf '%s' '([^']*)' >> /);
    return match ? [match[1]] : [];
  }).join("");

  assert.ok(encoded.length > 0);
  assert.equal(zlib.gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"), content);
  assert.equal(commands.every((command) => Buffer.byteLength(command, "utf8") < 64 * 1024), true);
  assert.ok(encoded.length < Buffer.byteLength(content, "utf8"));
});

test("plugin sync directory swap validates staged files and keeps a rollback path", () => {
  const command = buildPluginDirectorySwapCommand({
    targetDir: "/var/lib/forwardx-agent/plugins/demo",
    stagingDir: "/var/lib/forwardx-agent/plugins/.sync-demo-abc",
    backupDir: "/var/lib/forwardx-agent/plugins/.previous-demo",
    expectedFiles: [{
      path: "/var/lib/forwardx-agent/plugins/.sync-demo-abc/manifest.json",
      sha256: "a".repeat(64),
    }],
  });

  assert.match(command, /sha256sum/);
  assert.match(command, /\.previous-demo/);
  assert.match(command, /mv .*\.sync-demo-abc.*plugins\/demo/);
  assert.match(command, /exit "\$status"/);
});

test("plugin resourceSchema shorthand expands into generic Agent sources", () => {
  const manifest = normalizePluginManifest({
    id: "service-manager-demo",
    name: "Service manager demo",
    version: "1.0.0",
    permissions: ["read:hosts", "agent:read", "agent:write", "ui:interactive", "secret:reveal"],
    usageViews: [{ id: "hosts", type: "host-asset-sync", title: "Hosts", assetMode: "all-plugin-assets" }],
    actions: [
      {
        id: "list-services",
        label: "List",
        type: "agent.request",
        intent: "read",
        agent: { executor: "script", target: "selected-hosts", usageViewId: "hosts", entry: "manage.sh", arguments: ["list"], outputType: "json" },
        resultSchema: {
          type: "table",
          itemsPath: "items",
          fields: [
            { key: "name", label: "Name", copyable: true },
            { key: "status", label: "Status", type: "statusBadge" },
            { key: "token", label: "Token", secret: true, revealable: true },
            { key: "url", label: "URL", openable: true },
          ],
        },
      },
      {
        id: "service-detail",
        label: "Detail",
        type: "agent.request",
        intent: "read",
        agent: { executor: "script", target: "selected-hosts", usageViewId: "hosts", entry: "manage.sh", arguments: ["detail", "{{input.serviceId}}"], outputType: "json" },
      },
      {
        id: "save-service",
        label: "Save",
        type: "agent.request",
        intent: "write",
        agent: { executor: "script", target: "selected-hosts", usageViewId: "hosts", entry: "manage.sh", arguments: ["save", "{{input.payload}}"], outputType: "json" },
      },
      {
        id: "delete-service",
        label: "Delete",
        type: "agent.request",
        intent: "write",
        agent: { executor: "script", target: "selected-hosts", usageViewId: "hosts", entry: "manage.sh", arguments: ["delete", "{{input.serviceId}}"], outputType: "json" },
      },
    ],
    resourceSchema: {
      id: "services",
      type: "agent-resource",
      title: "Services",
      usageViewId: "hosts",
      rowKey: "serviceId",
      idInputKey: "serviceId",
      onOpen: "list-services",
      itemsPath: "items",
      detailAction: { actionId: "service-detail", inputKey: "serviceId" },
      columns: [
        { key: "name", label: "Name" },
        { key: "status", label: "Status", type: "status" },
      ],
      fields: [
        { key: "protocol", label: "Protocol", type: "select", options: [{ value: "tcp", label: "TCP" }] },
        { key: "port", label: "Port", type: "number", visibleWhen: [{ field: "protocol", operator: "eq", value: "tcp" }] },
      ],
      operations: {
        update: { actionId: "save-service", refreshAfter: ["list"] },
        delete: { actionId: "delete-service", refreshAfter: ["list"], confirmRequired: true },
      },
    },
  });

  assert.deepEqual(manifest.permissions, ["read:hosts", "agent:read", "agent:write", "ui:interactive", "secret:reveal"]);
  assert.equal(manifest.actions?.[0]?.intent, "read");
  assert.equal(manifest.actions?.[0]?.agent?.target, "selected-hosts");
  assert.equal(manifest.actions?.[0]?.resultSchema?.type, "table");
  assert.equal(manifest.actions?.[0]?.resultSchema?.fields[1]?.type, "statusBadge");
  assert.equal(manifest.actions?.[0]?.resultSchema?.fields[2]?.revealable, true);
  assert.equal(manifest.actions?.[0]?.resultSchema?.fields[3]?.openable, true);

  const schema = manifest.resourceSchemas?.[0];
  assert.ok(schema);
  assert.equal(schema.rowKey, "serviceId");
  assert.equal(schema.idInputKey, "serviceId");
  assert.equal(schema.listSourceId, "list");
  assert.equal(schema.detailSourceId, "detail");
  assert.deepEqual(schema.sources.map((source) => [source.id, source.actionId]), [
    ["list", "list-services"],
    ["detail", "service-detail"],
  ]);
  assert.deepEqual(schema.operations?.update?.refreshAfter, ["list"]);
  assert.deepEqual(schema.operations?.update?.refreshSources, ["list"]);
  assert.equal(schema.fields?.[1]?.visibleWhen?.[0]?.field, "protocol");
  assert.equal(manifest.resourceViews?.[0]?.id, "services");
});

test("invalid result and resource schema members are discarded", () => {
  const manifest = normalizePluginManifest({
    id: "schema-guard-demo",
    name: "Schema guard",
    version: "1",
    permissions: ["agent:read", "not:a-permission"],
    settingsSchema: [
      { key: "__forwardxSidebarEnabled", label: "Reserved", type: "boolean" },
      { key: "displayName", label: "Display name", type: "text" },
    ],
    actions: [{
      id: "read",
      label: "Read",
      type: "agent.request",
      intent: "read",
      resultSchema: { type: "unsupported", fields: [{ key: "value", label: "Value" }] },
      agent: { executor: "script", entry: "read.sh" },
    }],
    resourceSchema: { id: "broken", title: "Broken", onOpen: "", fields: [] },
  });

  assert.deepEqual(manifest.permissions, ["agent:read"]);
  assert.deepEqual(manifest.settingsSchema?.map((field) => field.key), ["displayname"]);
  assert.equal(manifest.actions?.[0]?.resultSchema, undefined);
  assert.deepEqual(manifest.resourceSchemas, []);
});

test("plugin sidebar entries require permission, extension point, and a valid target", () => {
  const manifest = normalizePluginManifest({
    id: "sidebar-demo",
    name: "Sidebar Demo",
    version: "1.0.0",
    permissions: ["ui:page"],
    extensionPoints: ["sidebar.page"],
    sidebar: { label: "Demo Page", target: "page", pageId: "home" },
    pages: [{ id: "home", title: "Home", content: "Hello" }],
  });
  const plugin = {
    pluginId: manifest.id,
    name: manifest.name,
    status: "enabled",
    manifest,
    permissions: manifest.permissions,
    extensionPoints: manifest.extensionPoints,
    sidebarEnabled: true,
  };

  assert.deepEqual(resolvePluginSidebarEntry(plugin), {
    pluginId: "sidebar-demo",
    label: "Demo Page",
    icon: "",
    target: "page",
    pageId: "home",
  });
  assert.equal(resolvePluginSidebarEntry({ ...plugin, permissions: [] }), null);
  assert.equal(resolvePluginSidebarEntry({ ...plugin, extensionPoints: [] }), null);
  assert.equal(resolvePluginSidebarEntry({ ...plugin, status: "disabled" })?.pluginId, "sidebar-demo");
  assert.equal(resolvePluginSidebarEntry({ ...plugin, sidebarEnabled: false }), null);

  const missingPage = normalizePluginManifest({
    ...manifest,
    sidebar: { target: "page", pageId: "missing" },
  });
  assert.equal(resolvePluginSidebarEntry({ ...plugin, manifest: missingPage }), null);
});

test("official whitelist exposes per-host province configuration CRUD", () => {
  const source = JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), "plugins/china-region-whitelist/forwardx-plugin.json"),
    "utf8",
  ));
  const manifest = normalizePluginManifest(source);
  const schema = manifest.resourceSchemas?.find((view) => view.id === "whitelist-host-manager");

  assert.equal(manifest.version, "0.6.2");
  assert.equal(manifest.usageViews?.[0]?.hostScope, "all");
  assert.ok(schema);
  assert.equal(schema.columns?.some((column) => column.key === "regionSummary"), true);
  assert.equal(schema.operations?.create?.actionId, "save-whitelist-config");
  assert.equal(schema.operations?.update?.actionId, "save-whitelist-config");
  assert.equal(schema.operations?.delete?.actionId, "delete-whitelist-config");
  const regions = schema.fields?.find((field) => field.key === "regions");
  const scopeMode = schema.fields?.find((field) => field.key === "scopeMode");
  const portSpec = schema.fields?.find((field) => field.key === "portSpec");
  assert.equal(regions?.options?.find((option) => option.value === "CN")?.exclusive, true);
  assert.equal(regions?.options?.some((option) => option.value === "440000"), true);
  assert.equal(scopeMode?.options?.some((option) => option.value === "port"), true);
  assert.deepEqual(portSpec?.visibleWhen, [{ field: "scopeMode", operator: "eq", value: "port" }]);

  const agentRunner = fs.readFileSync(
    path.resolve(process.cwd(), "plugins/china-region-whitelist/forwardx-agent-run.sh"),
    "utf8",
  );
  assert.doesNotMatch(agentRunner, /\bpython3\b/);
  assert.match(agentRunner, /command -v jq/);
});

test("plugin all-host scope resolves current hosts without persisting selections", () => {
  const allHostsView = normalizePluginManifest({
    id: "all-hosts-demo",
    name: "All hosts demo",
    version: "1.0.0",
    usageViews: [{ id: "hosts", type: "host-asset-sync", title: "Hosts", hostScope: "all" }],
  }).usageViews?.[0];
  const selectedView = normalizePluginManifest({
    id: "selected-hosts-demo",
    name: "Selected hosts demo",
    version: "1.0.0",
    usageViews: [{ id: "hosts", type: "host-asset-sync", title: "Hosts" }],
  }).usageViews?.[0];

  assert.deepEqual(resolvePluginUsageHostIds(allHostsView, { enabled: true, hostIds: [] }, [1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(resolvePluginUsageHostIds(allHostsView, { enabled: false, hostIds: [1] }, [1, 2]), []);
  assert.deepEqual(resolvePluginUsageHostIds(selectedView, { enabled: true, hostIds: [2, 9] }, [1, 2, 3]), [2]);
});

test("trusted panel actions retain only fixed operations and declared permissions", () => {
  const manifest = normalizePluginManifest({
    id: "panel-api-demo",
    name: "Panel API demo",
    version: "1.0.0",
    permissions: ["read:users", "write:rules", "telegram:send"],
    actions: [
      { id: "users", label: "Users", type: "panel.request", panel: { operation: "users.list" } },
      { id: "send", label: "Send", type: "panel.request", panelRequest: { operation: "telegram.send" } },
      { id: "unsafe", label: "Unsafe", type: "panel.request", panel: { operation: "database.query" } },
    ],
  });

  assert.deepEqual(manifest.permissions, ["read:users", "write:rules", "telegram:send"]);
  assert.deepEqual(manifest.actions?.map((action) => [action.id, action.panel?.operation]), [
    ["users", "users.list"],
    ["send", "telegram.send"],
  ]);
  assert.equal(pluginManifestRequiresTrust(manifest), true);

  const regularPlugin = normalizePluginManifest({
    id: "regular-plugin",
    name: "Regular plugin",
    version: "1.0.0",
    permissions: ["agent:read", "ui:page"],
    actions: [{ id: "status", label: "Status", type: "noop" }],
  });
  assert.equal(pluginManifestRequiresTrust(regularPlugin), false);
  assert.equal(shouldPreservePluginTrust(regularPlugin, manifest), false);
  assert.equal(shouldPreservePluginTrust(manifest, { ...manifest }), true);

  const expandedManifest = normalizePluginManifest({
    ...manifest,
    permissions: [...(manifest.permissions || []), "write:users"],
    actions: [
      ...(manifest.actions || []),
      { id: "disable-user", label: "Disable user", type: "panel.request", panel: { operation: "users.setAccountEnabled" } },
    ],
  });
  assert.equal(shouldPreservePluginTrust(manifest, expandedManifest), false);
});

test("third-party store catalog annotates source and defaults package repository", () => {
  const catalog = normalizePluginStoreCatalog({
    name: "Community Store",
    plugins: [{
      id: "community-demo",
      name: "Community Demo",
      description: "Demo",
      version: "1.0.0",
      packagePath: "dist/community-demo.zip",
      permissions: ["read:hosts"],
      extensionPoints: [],
    }],
  }, {
    id: 7,
    repository: "https://github.com/example/community-store",
    branch: "main",
    catalogPath: "forwardx-store.json",
  });

  assert.equal(catalog.name, "Community Store");
  assert.equal(catalog.items[0]?.official, false);
  assert.equal(catalog.items[0]?.storeSourceId, 7);
  assert.equal(catalog.items[0]?.storeSourceName, "Community Store");
  assert.equal(catalog.items[0]?.packageRepository, "https://github.com/example/community-store");
});

test("plugin update comparison only accepts a newer version", () => {
  assert.equal(pluginVersionHasUpdate("1.9.0", "1.10.0"), true);
  assert.equal(pluginVersionHasUpdate("v2.0.0", "2.0.0"), false);
  assert.equal(pluginVersionHasUpdate("2.1.0", "2.0.9"), false);
  assert.equal(pluginVersionHasUpdate("2.1.0", ""), false);
});
