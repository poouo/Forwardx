import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { readFileSync } from "node:fs";
import DatabaseHealthGate, { DatabaseUnavailableView } from "./DatabaseHealthGate";
import type { DatabaseHealth } from "@shared/databaseHealth";

const healthSnapshot = (state: DatabaseHealth["state"]): DatabaseHealth => ({ state, databaseType: "sqlite", checkedAt: null, unavailableSince: null, reason: null, restartRequired: false });

function renderGate(health?: DatabaseHealth | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (health !== undefined) client.setQueryData(["database-health", ""], health);
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}><Router ssrPath="/rules"><DatabaseHealthGate><main>Panel content</main></DatabaseHealthGate></Router></QueryClientProvider>);
  } finally {
    client.clear();
  }
}

test("initial health checks and normal states render content immediately without a full-screen interstitial", () => {
  for (const health of [undefined, null, healthSnapshot("checking"), healthSnapshot("healthy"), healthSnapshot("not_configured")]) {
    const html = renderGate(health);
    assert.match(html, /<main>Panel content<\/main>/);
    assert.doesNotMatch(html, /正在检查面板状态|Checking panel status|role="status"/);
  }
});

test("a confirmed outage still blocks normal content with the recovery view", () => {
  const html = renderGate(healthSnapshot("unavailable"));
  assert.match(html, /数据库暂时不可用/);
  assert.match(html, /role="alert"/);
  assert.match(html, /检查中|重新检查/);
  assert.doesNotMatch(html, /Panel content/);
});

test("normal startup does not invalidate every query again when the first healthy result arrives", () => {
  const source = readFileSync("client/src/components/DatabaseHealthGate.tsx", "utf8");
  assert.match(source, /state === "unavailable"\) wasUnavailable\.current = true/);
  assert.match(source, /state === "healthy" && wasUnavailable\.current/);
  assert.match(source, /wasUnavailable\.current = false/);
  assert.match(source, /queryClient\.invalidateQueries/);
  assert.doesNotMatch(source, /if \(health\.isLoading\)/);
});

test("database diagnostic view shows safe reasons without exposing a setup or login form", () => {
  const html = renderToStaticMarkup(<DatabaseUnavailableView health={{ state: "unavailable", databaseType: "postgresql", checkedAt: "2026-10-02T00:00:00Z", unavailableSince: "2026-10-02T00:00:00Z", reason: { code: "ECONNREFUSED", message: "数据库连接被拒绝", suggestion: "检查数据库服务是否启动" }, restartRequired: false }} checking={false} onRetry={() => {}} />);
  assert.match(html, /数据库暂时不可用/);
  assert.match(html, /PostgreSQL/);
  assert.match(html, /ECONNREFUSED/);
  assert.match(html, /数据库连接被拒绝/);
  assert.match(html, /重新检查/);
  assert.doesNotMatch(html, /type="password"|创建管理员|href="\/setup"/);
});
