import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import HostAddressSelectors from "./HostAddressSelectors";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "../../i18n";

test("primary IPv4 and IPv6 controls render independently with English upgrade guidance", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en"); await initializeLanguage();
    const html = renderToStaticMarkup(<HostAddressSelectors host={{ id: 1, ipv4: "1.1.1.1", ipv6: "2606:4700:4700::1111", ipv4Addresses: '["1.1.1.1","8.8.8.8"]' }} preferredIpv4="8.8.8.8" preferredIpv6="" onChange={() => {}} />);
    assert.match(html, /Primary IPv4/); assert.match(html, /Primary IPv6/);
    assert.match(html, /host-primary-ipv4/); assert.match(html, /host-primary-ipv6/);
    assert.match(html, /Update the Agent/); assert.doesNotMatch(html, /\p{Script=Han}/u);
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});
