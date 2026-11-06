import assert from "node:assert/strict";
import test from "node:test";

import { appendRuleEntryIpv6Addresses, filterRuleEntryAddressesForDisplay, formatRuleEntryAddress, getEntryAddressFamily, partitionRuleEntryAddresses, resolveRuleEntryHost } from "./ruleEntryDisplay";

test("uses a nested shared-resource host when it is not in the global host list", () => {
  const nestedHost: { id: number; ddnsEnabled?: boolean; ddnsDomain?: string; ipv4?: string } = {
    id: 42,
    ddnsEnabled: true,
    ddnsDomain: "entry.example.com",
    ipv4: "198.51.100.42",
  };
  assert.equal(resolveRuleEntryHost([], 42, nestedHost), nestedHost);
  assert.equal(resolveRuleEntryHost([{ id: 42, ipv4: "198.51.100.42" }], 42, nestedHost)?.ipv4, "198.51.100.42");
});

test("keeps IPv6 available for copying alongside an IPv4 rule entry", () => {
  assert.deepEqual(filterRuleEntryAddressesForDisplay([
    { label: "IPv4", value: "198.51.100.8" },
    { label: "IPv6", value: "2001:db8::8" },
  ]), [
    { label: "IPv4", value: "198.51.100.8" },
    { label: "IPv6", value: "2001:db8::8" },
  ]);
});

test("keeps IPv6 available for copying alongside a domain rule entry", () => {
  assert.deepEqual(filterRuleEntryAddressesForDisplay([
    { label: "DDNS", value: "entry.example.com" },
    { label: "IPv6", value: "2001:db8::9" },
  ]), [
    { label: "DDNS", value: "entry.example.com" },
    { label: "IPv6", value: "2001:db8::9" },
  ]);
});

test("recognizes underscore host entries and preserves preferred address order", () => {
  assert.deepEqual(filterRuleEntryAddressesForDisplay([
    { label: "IPv6", value: "2001:db8::12" },
    { label: "自定义", value: "entry_node.example.com" },
    { label: "IPv4", value: "198.51.100.12" },
  ]), [
    { label: "IPv6", value: "2001:db8::12" },
    { label: "自定义", value: "entry_node.example.com" },
    { label: "IPv4", value: "198.51.100.12" },
  ]);
});

test("keeps IPv6 when it is the only usable address family", () => {
  const entries = [
    { label: "IPv6", value: "2001:db8::10" },
    { label: "入口", value: "unix:/run/forwardx.sock" },
  ];
  assert.deepEqual(filterRuleEntryAddressesForDisplay(entries), entries);
});

test("recognizes bracketed and zone-scoped IPv6 addresses", () => {
  assert.equal(getEntryAddressFamily("[2001:db8::11]:443"), "ipv6");
  assert.equal(getEntryAddressFamily("fe80::1%eth0"), "ipv6");
});

test("formats each copy target with an unambiguous IPv6 address and rule port", () => {
  const entries = filterRuleEntryAddressesForDisplay([
    { label: "DDNS", value: "entry.example.com" },
    { label: "IPv4", value: "198.51.100.8" },
    { label: "IPv6", value: "2001:db8::8" },
  ]);
  assert.deepEqual(entries.map(entry => formatRuleEntryAddress(entry.value, 8443)), [
    "entry.example.com:8443", "198.51.100.8:8443", "[2001:db8::8]:8443",
  ]);
  assert.equal(formatRuleEntryAddress("[2001:db8::8]", "8000-8010"), "[2001:db8::8]:8000-8010");
  assert.equal(formatRuleEntryAddress("fe80::1%eth0", 443), "[fe80::1%eth0]:443");
  assert.equal(formatRuleEntryAddress("", 443), "");
});

test("removes empty entries without mutating the provided address list", () => {
  const entries = [{ label: "入口", value: " " }, { label: "IPv6", value: "2001:db8::1" }];
  assert.deepEqual(filterRuleEntryAddressesForDisplay(entries), [entries[1]]);
  assert.equal(entries.length, 2);
});

test("domain-based groups expose member IPv6 entries without replacing their preferred domain", () => {
  const entries = [{ label: "入口组", value: "entry.example.com" }];
  const ipv6 = { label: "IPv6", value: "2001:db8::10" };
  assert.deepEqual(appendRuleEntryIpv6Addresses(entries, [
    { label: "IPv4", value: "198.51.100.10" }, ipv6, ipv6,
    { label: "IPv6", value: "2001:db8::11" },
  ]), [entries[0], ipv6, { label: "IPv6", value: "2001:db8::11" }]);
  assert.equal(entries.length, 1);
});

test("secondary IPv6 entries stay available in the popup while preferred entries stay visible", () => {
  const ipv6 = { label: "IPv6", value: "2001:db8::1" };
  const domain = { label: "DDNS", value: "entry.example.com" };
  const ipv4 = { label: "IPv4", value: "198.51.100.1" };
  assert.deepEqual(partitionRuleEntryAddresses([ipv6, domain, ipv4]), { visible: [domain, ipv4], hidden: [ipv6] });
  assert.deepEqual(partitionRuleEntryAddresses([ipv6]), { visible: [ipv6], hidden: [] });
});
