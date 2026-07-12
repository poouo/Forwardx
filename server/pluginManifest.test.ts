import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { normalizePluginManifest, normalizePluginStoreCatalog } from "./repositories/pluginRepository";

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
  assert.equal(manifest.actions?.[0]?.resultSchema, undefined);
  assert.deepEqual(manifest.resourceSchemas, []);
});

test("official whitelist exposes per-host province configuration CRUD", () => {
  const source = JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), "plugins/china-region-whitelist/forwardx-plugin.json"),
    "utf8",
  ));
  const manifest = normalizePluginManifest(source);
  const schema = manifest.resourceSchemas?.find((view) => view.id === "whitelist-host-manager");

  assert.equal(manifest.version, "0.5.0");
  assert.ok(schema);
  assert.equal(schema.columns?.some((column) => column.key === "regionSummary"), true);
  assert.equal(schema.operations?.create?.actionId, "save-whitelist-config");
  assert.equal(schema.operations?.update?.actionId, "save-whitelist-config");
  assert.equal(schema.operations?.delete?.actionId, "delete-whitelist-config");
  const regions = schema.fields?.find((field) => field.key === "regions");
  assert.equal(regions?.options?.find((option) => option.value === "CN")?.exclusive, true);
  assert.equal(regions?.options?.some((option) => option.value === "440000"), true);
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
