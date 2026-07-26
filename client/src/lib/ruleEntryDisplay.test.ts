import assert from "node:assert/strict";
import test from "node:test";

import { filterRuleEntryAddressesForDisplay, getEntryAddressFamily } from "./ruleEntryDisplay";

test("hides IPv6 when an IPv4 rule entry is available", () => {
  assert.deepEqual(filterRuleEntryAddressesForDisplay([
    { label: "IPv4", value: "198.51.100.8" },
    { label: "IPv6", value: "2001:db8::8" },
  ]), [
    { label: "IPv4", value: "198.51.100.8" },
  ]);
});

test("hides IPv6 when a domain rule entry is available", () => {
  assert.deepEqual(filterRuleEntryAddressesForDisplay([
    { label: "DDNS", value: "entry.example.com" },
    { label: "IPv6", value: "2001:db8::9" },
  ]), [
    { label: "DDNS", value: "entry.example.com" },
  ]);
});

test("recognizes underscore host entries and preserves preferred address order", () => {
  assert.deepEqual(filterRuleEntryAddressesForDisplay([
    { label: "IPv6", value: "2001:db8::12" },
    { label: "自定义", value: "entry_node.example.com" },
    { label: "IPv4", value: "198.51.100.12" },
  ]), [
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
