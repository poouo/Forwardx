import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BBR_FQ_PRESET } from "@shared/sysctlConfig";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import SysctlEditor from "./SysctlEditor";

test("sysctl editor provides visual/text modes and minimal preset", () => {
  const html = renderToStaticMarkup(<SysctlEditor value={BBR_FQ_PRESET} onChange={() => {}} />);
  assert.match(html, /图形化/);
  assert.match(html, /高级文本/);
  assert.match(html, /BBR \+ FQ/);
  assert.match(html, /更多 TCP 参数/);
  assert.match(html, /<option value="bbr" selected="">/);
  assert.match(html, /<option value="fq" selected="">/);
  assert.match(html, /grid-cols-2/);
  assert.doesNotMatch(html, /<textarea/);
});

test("invalid text is editable and prevents switching to visual mode", () => {
  const html = renderToStaticMarkup(<SysctlEditor value="kernel.panic=1" onChange={() => {}} />);
  assert.match(html, /<textarea[^>]*aria-label="sysctl 配置"/);
  assert.match(html, /kernel.panic=1/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-pressed="false"[^>]*disabled=""/);
});

test("kernel-specific algorithm values are retained and controls respect read-only", () => {
  const html = renderToStaticMarkup(<SysctlEditor value={"net.ipv4.tcp_congestion_control=custom_bbr\n"} onChange={() => {}} disabled />);
  assert.match(html, /<option value="custom_bbr" selected="">/);
  assert.match(html, /<select[^>]*disabled=""/);
  assert.match(html, /<input[^>]*disabled=""/);
});

test("sysctl editor labels support English", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en"); await initializeLanguage();
    const html = renderToStaticMarkup(<SysctlEditor value={BBR_FQ_PRESET} onChange={() => {}} />);
    assert.match(html, /Advanced text/);
    assert.doesNotMatch(html, /\p{Script=Han}/u);
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});
