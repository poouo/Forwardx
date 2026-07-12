import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginResultRenderer } from "./PluginResultRenderer";

test("resultSchema renders structured table data without exposing secrets", () => {
  const markup = renderToStaticMarkup(
    <PluginResultRenderer
      canRevealSecrets
      data={{
        items: [{ name: "node-a", status: "online", token: "secret-value", url: "https://example.com/node-a" }],
      }}
      schema={{
        type: "table",
        itemsPath: "items",
        fields: [
          { key: "name", label: "Name", copyable: true },
          { key: "status", label: "Status", type: "statusBadge" },
          { key: "token", label: "Token", secret: true, revealable: true, copyable: true },
          { key: "url", label: "URL", openable: true },
        ],
      }}
    />,
  );

  assert.match(markup, /node-a/);
  assert.match(markup, /online/);
  assert.match(markup, /打开/);
  assert.match(markup, /••••••••/);
  assert.doesNotMatch(markup, /secret-value/);
  assert.doesNotMatch(markup, /<pre/);
});

test("resultSchema renders keyValue fields and boolean labels", () => {
  const markup = renderToStaticMarkup(
    <PluginResultRenderer
      canRevealSecrets={false}
      data={{ configured: true, port: 443 }}
      schema={{
        type: "keyValue",
        fields: [
          { key: "configured", label: "Configured", type: "statusBadge", trueLabel: "Applied", falseLabel: "Missing" },
          { key: "port", label: "Port", type: "number" },
        ],
      }}
    />,
  );

  assert.match(markup, /Configured/);
  assert.match(markup, /Applied/);
  assert.match(markup, /443/);
});
