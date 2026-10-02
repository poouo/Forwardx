import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DatabaseUnavailableView } from "./DatabaseHealthGate";

test("database diagnostic view shows safe reasons without exposing a setup or login form", () => {
  const html = renderToStaticMarkup(<DatabaseUnavailableView health={{ state: "unavailable", databaseType: "postgresql", checkedAt: "2026-10-02T00:00:00Z", unavailableSince: "2026-10-02T00:00:00Z", reason: { code: "ECONNREFUSED", message: "数据库连接被拒绝", suggestion: "检查数据库服务是否启动" }, restartRequired: false }} checking={false} onRetry={() => {}} />);
  assert.match(html, /数据库暂时不可用/);
  assert.match(html, /PostgreSQL/);
  assert.match(html, /ECONNREFUSED/);
  assert.match(html, /数据库连接被拒绝/);
  assert.match(html, /重新检查/);
  assert.doesNotMatch(html, /type="password"|创建管理员|href="\/setup"/);
});
