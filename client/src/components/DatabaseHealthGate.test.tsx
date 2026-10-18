import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { readFileSync } from "node:fs";
import DatabaseHealthGate, { DatabaseUnavailableView } from "./DatabaseHealthGate";
import type { DatabaseHealth } from "@shared/databaseHealth";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import { DatabaseHealthTracker, describeDatabaseError } from "../../../server/databaseHealthState";

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

test("known database reasons and recovery suggestions render fully in Chinese and English", async () => {
  const previous = getLanguagePreference();
  const codes = ["ECONNREFUSED","ENOTFOUND","ETIMEDOUT","PROTOCOL_CONNECTION_LOST","ER_HOST_NOT_PRIVILEGED","ER_HOST_IS_BLOCKED","ER_ACCESS_DENIED_ERROR","ER_DBACCESS_DENIED_ERROR","ER_TABLEACCESS_DENIED_ERROR","ER_NO_SUCH_TABLE","ER_PARSE_ERROR","ER_TOO_LONG_KEY","ER_DUP_ENTRY","ER_RECORD_FILE_FULL","ER_LOCK_WAIT_TIMEOUT","ER_BAD_DB_ERROR","ER_CON_COUNT_ERROR","SQLITE_FULL","CERT_HAS_EXPIRED"];
  try {
    for (const language of ["zh-CN","en"] as const) {
      setLanguagePreference(language);await initializeLanguage();
      for (const code of [...codes,"UNKNOWN_ERROR"]) {
        const tracker = new DatabaseHealthTracker(() => {});
        tracker.configure("mysql");
        tracker.unavailable({code,message:"private-secret private-host SELECT private-query"},true);
        const html = renderToStaticMarkup(<DatabaseUnavailableView health={tracker.snapshot()} checking={false} onRetry={() => {}} />);
        assert.ok(html.includes(code === "UNKNOWN_ERROR" ? "INITIALIZATION_FAILED" : code));
        assert.doesNotMatch(html,/private-secret|private-host|private-query/);
        if (language === "en") assert.doesNotMatch(html,/\p{Script=Han}/u,`untranslated database error ${code}`);
        else assert.match(html,/数据库|MySQL/);
      }
      const host = describeDatabaseError({errno:1130},true)!;
      const html = renderToStaticMarkup(<DatabaseUnavailableView health={{...healthSnapshot("unavailable"),reason:host}} checking={false} onRetry={() => {}} />);
      assert.ok(html.includes(language === "en" ? "MySQL does not allow connections from the panel host" : "MySQL 不允许面板所在主机连接"));
    }
  } finally {setLanguagePreference(previous);await initializeLanguage();}
});
