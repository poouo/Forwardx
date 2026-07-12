import assert from "node:assert/strict";
import test from "node:test";
import { normalizePluginManifest } from "./repositories/pluginRepository";

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
