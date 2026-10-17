import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import OperationsRefreshSelect from "./OperationsRefreshSelect";
import { OPERATIONS_REFRESH_SECONDS, normalizeOperationsRefresh, operationsRefreshInterval, operationsRefreshOptions, operationsRefreshStorageKey } from "@/lib/operationsRefresh";

test("refresh choices default to 30s and accept only the supported intervals", () => {
  assert.deepEqual(OPERATIONS_REFRESH_SECONDS, [5, 10, 30, 0]);
  for (const value of OPERATIONS_REFRESH_SECONDS) {
    assert.equal(normalizeOperationsRefresh(value), value);
    assert.equal(normalizeOperationsRefresh(String(value)), value);
  }
  for (const invalid of [undefined, null, "", " ", false, true, [], {}, "bad", -1, 1, 60, Infinity]) {
    assert.equal(normalizeOperationsRefresh(invalid), 30);
  }
  assert.notEqual(operationsRefreshStorageKey(1), operationsRefreshStorageKey(2));
});

test("auto-refresh runs only on the visible dashboard, with no timers when off or away", () => {
  for (const seconds of OPERATIONS_REFRESH_SECONDS) {
    assert.equal(operationsRefreshInterval(seconds, true, "/operations"), seconds ? seconds * 1000 : false);
    assert.equal(operationsRefreshInterval(seconds, true, "/operations?scope=all"), seconds ? seconds * 1000 : false);
    assert.equal(operationsRefreshInterval(seconds, false, "/operations"), false);
    for (const path of ["/", "/rules", "/operations-other"]) assert.equal(operationsRefreshInterval(seconds, true, path), false);
  }
  assert.deepEqual(operationsRefreshOptions(false), { refetchInterval: false, refetchIntervalInBackground: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
});

test("refresh controls expose a linked label and the selected interval in both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      for (const seconds of OPERATIONS_REFRESH_SECONDS) {
        const html = renderToStaticMarkup(<OperationsRefreshSelect seconds={seconds} onChange={() => {}} />);
        assert.match(html, /for="operations-refresh"/);
        assert.match(html, /id="operations-refresh"/);
        assert.match(html, /role="combobox"/);
        assert.match(html, /w-\[110px\]/);
        if (seconds) assert.ok(html.includes(`${seconds}s`));
        else assert.ok(html.includes(language === "en" ? "Off" : "不刷新"));
        if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
      }
    }
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("all dashboard queries share the selected refresh policy, including finance and open details", () => {
  const page = readFileSync("client/src/pages/Operations.tsx", "utf8");
  const finance = readFileSync("client/src/components/OperationsFinanceSummary.tsx", "utf8");
  const hook = readFileSync("client/src/hooks/useOperationsRefresh.ts", "utf8");
  assert.match(page, /useOperationsRefresh\(user\?\.id\)/);
  assert.match(page, /operationsRefreshOptions\(refreshInterval\)/);
  assert.match(page, /<OperationsFinanceSummary[^>]*refreshInterval=\{refreshInterval\}/);
  for (const query of ["overview", "sources", "provinceDetails", "sourceDetails"]) {
    assert.match(page, new RegExp(`trpc\\.operations\\.${query}\\.useQuery\\([^;]+refreshOptions`));
  }
  assert.match(finance, /operationsRefreshOptions\(refreshInterval\)/);
  assert.doesNotMatch(page + finance, /60_000/);
  assert.match(hook, /useSyncExternalStore\(subscribeVisibility, isVisible, \(\) => false\)/);
  assert.match(hook, /document\.addEventListener\("visibilitychange", onChange\)/);
  assert.match(hook, /document\.removeEventListener\("visibilitychange", onChange\)/);
  assert.match(hook, /localStorage\.setItem\(operationsRefreshStorageKey\(userId\)/);
});
