import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import HostLoad from "./HostLoad";

test("compact host load renders in both languages without turning unavailable data into zero", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      const html = renderToStaticMarkup(<HostLoad metric={{ load1: 0, load5: 1.23, load15: 2.34 }} />);
      assert.ok(html.includes(language === "en" ? "Load" : "负载"));
      assert.match(html, /<span>0\.00<\/span><span>1\.23<\/span><span>2\.34<\/span>/);
      assert.ok(!html.includes(" / "));
      assert.match(html, /inline-flex items-center gap-2/);
      assert.match(html, /tabular-nums/);
      const inline = renderToStaticMarkup(<HostLoad metric={{ load1: 0, load5: 1.23, load15: 2.34 }} showLabel={false} />);
      assert.ok(!inline.includes(language === "en" ? "Load" : "负载"));
      assert.match(inline, /<span>0\.00<\/span><span>1\.23<\/span><span>2\.34<\/span>/);
      const missing = renderToStaticMarkup(<HostLoad />);
      assert.match(missing, /<span>—<\/span><span>—<\/span><span>—<\/span>/);
      assert.ok(!missing.includes("0.00"));
    }
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});
