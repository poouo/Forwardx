import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import { formatRuleEntryAddress } from "@/lib/ruleEntryDisplay";
import { RuleEntryAddresses } from "./RuleEntryAddresses";

const ipv4 = { label: "IPv4", value: "198.51.100.8", text: "198.51.100.8:8443", copyable: true };
const ipv6 = { label: "IPv6", value: "2001:db8::8", text: formatRuleEntryAddress("2001:db8::8", 8443), copyable: true };

test("cards and tables keep IPv6 collapsed with an accessible hover/click trigger", () => {
  for (const table of [false, true]) {
    const html = renderToStaticMarkup(<RuleEntryAddresses entries={[ipv4, ipv6]} table={table} onCopy={() => {}} />);
    assert.match(html, /198\.51\.100\.8:8443/);
    assert.doesNotMatch(html, /2001:db8::8/);
    assert.match(html, /aria-haspopup="dialog"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, />IPv6</);
  }
});

test("IPv6-only rules remain directly visible and copyable without expansion", () => {
  const html = renderToStaticMarkup(<RuleEntryAddresses entries={[ipv6]} onCopy={() => {}} />);
  assert.match(html, /\[2001:db8::8\]:8443/);
  assert.match(html, /aria-label="[^"]*\[2001:db8::8\]:8443/);
  assert.doesNotMatch(html, /aria-haspopup/);
});

test("unavailable entries remain disabled and do not offer an empty IPv6 popup", () => {
  const html = renderToStaticMarkup(<RuleEntryAddresses entries={[{ label: "入口", value: "", text: "入口地址暂不可用", copyable: false }]} onCopy={() => {}} />);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /aria-haspopup/);
});

test("the expansion control is translated in English", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en");
    await initializeLanguage();
    const html = renderToStaticMarkup(<RuleEntryAddresses entries={[ipv4, ipv6]} onCopy={() => {}} />);
    assert.match(html, /View IPv6 entries/);
    assert.doesNotMatch(html, /\p{Script=Han}/u);
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});
