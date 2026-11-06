import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { transpileModule } from "typescript";
import { appendRuleEntryIpv6Addresses, filterRuleEntryAddressesForDisplay, getEntryAddressFamily, resolveRuleEntryHost } from "@/lib/ruleEntryDisplay";

const source = readFileSync("client/src/pages/Rules.tsx", "utf8");
const card = source.slice(source.indexOf("  const renderTransfer ="), source.indexOf("  const renderTableTransferEntry ="));
const table = source.slice(source.indexOf("  const renderTableTransferEntry ="), source.indexOf("  const renderTableTransferExit ="));

test("compact cards share inline entry/exit readouts while full cards retain their original layout", () => {
  assert.equal((card.match(/<div className=\{panelClass\}>/g) || []).length, 2);
  assert.equal((card.match(/<div className=\{labelClass\}>/g) || []).length, 2);
  assert.match(card, /rounded-xl border border-border\/50 px-2 py-1\.5/);
  assert.match(card, /rounded-xl border border-border\/50 px-2\.5 py-2/);
  assert.match(card, /min-w-0 break-all text-\[11px\] leading-4/);
  assert.match(card, /min-w-0 break-all text-xs leading-5/);
  assert.match(card, /const inlineEndpoints = effectiveRuleCardSize === "compact"/);
  assert.match(card, /pearl-readout flex min-w-0 items-start gap-1\.5/);
  assert.match(card, /shrink-0 whitespace-nowrap py-0\.5/);
  assert.match(card, /className=\{cn\(valueClass, "flex-1 text-left"\)\} title=\{inlineEndpoints \? entry.text : undefined\}>\{entry.text\}/);
  assert.match(card, /const valueClass = inlineEndpoints\s*\? "min-w-0 flex-1 truncate/);
  assert.match(card, /title=\{targetAddress\}/);
  assert.match(card, /flex-1 rounded px-1\.5/);
  assert.match(card, /inlineEndpoints \? "py-0\.5" : "bg-muted\/35 py-1"/);
  assert.doesNotMatch(card, /Popover|RuleEntryAddresses|line-clamp/);
});

test("cards and table entries copy the selected full address with no IPv6 expansion control", () => {
  for (const view of [card, table]) {
    assert.match(view, /onClick=\{\(\) => entry.copyable && copyEntryAddress\(rule, entry.value\)\}/);
    assert.match(view, /disabled=\{!entry.copyable\}/);
    assert.doesNotMatch(view, /Popover|RuleEntryAddresses|aria-haspopup/);
  }
  assert.match(table, /min-w-0 truncate/);
  assert.match(card, /title=\{entry.copyable \? translateText\("复制入口地址: \{0\}", \[entry.text\]\)/);
  assert.match(source, /return \x60\[\$\{value\}\]:\$\{port\}\x60/);
});

test("IPv4/domain preference and directly copyable IPv6-only entries match the previous version", () => {
  const ipv6 = { label: "IPv6", value: "2001:db8::8" };
  const ipv4 = { label: "IPv4", value: "198.51.100.8" };
  const domain = { label: "DDNS", value: "entry.example.com" };
  assert.deepEqual(filterRuleEntryAddressesForDisplay([ipv4, ipv6]), [ipv4]);
  assert.deepEqual(filterRuleEntryAddressesForDisplay([domain, ipv6]), [domain]);
  assert.deepEqual(filterRuleEntryAddressesForDisplay([ipv6]), [ipv6]);
  assert.doesNotMatch(source, /partitionRuleEntryAddresses/);
});

test("only standard cards opt into IPv6 alternatives and label individually copyable addresses", () => {
  assert.match(card, /getRuleTransferDisplay\(rule, effectiveRuleCardSize === "standard"\)/);
  assert.match(table, /getRuleTransferDisplay\(rule\)/);
  assert.match(card, /!inlineEndpoints && entry.copyable/);
  assert.doesNotMatch(card, /!inlineEndpoints && entryAddresses.length > 1/);
  assert.match(card, /addressFamily\(entry.value\) === "ipv6" \? "IPv6" : "IPv4"/);
  assert.doesNotMatch(card, /translateText\(entry.label\)|justify-between/);
  assert.match(card, /w-\[4ch\] shrink-0 text-\[10px\]/);
  assert.match(card, /cn\(valueClass, "flex-1 text-left"\)/);
  assert.match(source, /filterRuleEntryAddressesForDisplay\(entryItems, includeIpv6\)/);
  assert.match(source, /getForwardChainEntryAddresses\(group, includeIpv6\)/);
  assert.match(source, /getForwardGroupEntryAddresses\(group, includeIpv6\)/);
  assert.match(source, /getTunnelEntryAddresses\(tunnel, includeIpv6\)/);
});

test("standard cards share native row tracks for headers, entries, exits and statistics", () => {
  const css = readFileSync("client/src/index.css", "utf8");
  const cards = source.slice(source.indexOf("  const renderRuleCard ="), source.indexOf("  return (\n    <div className=\"space-y-6\">"));
  const compact = cards.slice(0, cards.indexOf("rule-standard-card border-border"));
  assert.doesNotMatch(compact, /rule-standard-card-content|rule-standard-card-transfer/);
  assert.match(cards, /action-card-content rule-standard-card-content p-4/);
  assert.match(cards, /rule-standard-card-transfer min-w-0/);
  assert.match(card, /inlineEndpoints \? "space-y-1.5" : "rule-standard-transfer-sections"/);
  assert.match(css, /@supports \(grid-template-rows: subgrid\)/);
  for (const selector of [".rule-standard-card", ".rule-standard-card-content"]) {
    const blocks = [...css.matchAll(new RegExp(`${selector.replaceAll(".", "\\.")} \\{([^}]+)\\}`, "g"))];
    assert.ok(blocks.some((block) => /grid-row: span 7/.test(block[1]) && /grid-template-rows: subgrid/.test(block[1])));
  }
  assert.match(css, /\.rule-standard-card-transfer > \.rule-standard-transfer-sections\s*\{[^}]*grid-row: span 3;[^}]*grid-template-rows: subgrid;/);
});

// Exercise the actual page resolvers with small ACL-filtered resource payloads.
function entryResolvers(hosts: any[] = [], groups: any[] = [], tunnels: any[] = []) {
  const helpers = source.slice(source.indexOf("function pushUniqueEntryAddress("), source.indexOf("function getForwardGroupRouteLabel("));
  const resolvers = source.slice(source.indexOf("  const entryDomainForForwardGroup ="), source.indexOf("  /** 复制入口 IP:端口"));
  const body = transpileModule(`
    const { hosts, forwardGroupById, tunnelById, addressFamily, resolveRuleEntryHost,
      appendRuleEntryIpv6Addresses, enabledHostMembers, getTunnelHopIds,
      getForwardGroupRouteLabel, getRuleEntryHost } = context;
    ${helpers}
    ${resolvers}
    return { getRuleEntries, getTunnelEntryAddresses, getForwardGroupEntryAddresses, getForwardChainEntryAddresses, formatAddressWithPort };
  `, {}).outputText;
  return new Function("context", body)({
    hosts,
    forwardGroupById: new Map(groups.map((group) => [group.id, group])),
    tunnelById: new Map(tunnels.map((tunnel) => [tunnel.id, tunnel])),
    addressFamily: getEntryAddressFamily, resolveRuleEntryHost, appendRuleEntryIpv6Addresses,
    enabledHostMembers: (group: any) => group.members.filter((member: any) => member.isEnabled !== false && member.hostId),
    getTunnelHopIds: (tunnel: any) => [tunnel.entryHostId, tunnel.exitHostId],
    getForwardGroupRouteLabel: () => "入口组",
    getRuleEntryHost: (rule: any) => hosts.find((host) => host.id === rule.hostId),
  });
}

test("ordinary host and tunnel cards retain their preferred entry and add only enabled entry-host IPv6", () => {
  const entry = { id: 1, ipv4: "198.51.100.1", ipv6: "2001:db8::1" };
  const other = { id: 2, ipv6: "2001:db8::2" };
  const disabled = { id: 3, ipv6: "2001:db8::3" };
  const exit = { id: 4, ipv6: "2001:db8::4" };
  const entryGroup = { id: 10, groupMode: "entry", domain: "entry.example.com", members: [
    { hostId: 1, host: entry }, { hostId: 2, host: other }, { hostId: 3, host: disabled, isEnabled: false },
  ] };
  const tunnel = { id: 20, entryGroupId: 10, entryHostId: 1, exitHostId: 4, entryGroup, exitHost: exit };
  const api = entryResolvers([entry], [entryGroup], [tunnel]);
  assert.deepEqual(api.getRuleEntries({ hostId: 1 }, true).map((row: any) => row.value), [entry.ipv4, entry.ipv6]);
  assert.deepEqual(api.getRuleEntries({ tunnelId: 20 }).map((row: any) => row.value), [entryGroup.domain]);
  assert.deepEqual(api.getRuleEntries({ tunnelId: 20 }, true).map((row: any) => row.value), [entryGroup.domain, entry.ipv6, other.ipv6]);
  assert.equal(api.formatAddressWithPort(entry.ipv6, 8080), "[2001:db8::1]:8080");
});

test("failover group IPv6 alternatives follow the active member rather than an inactive host", () => {
  const group = { domain: "entry.example.com", activeMemberId: 2, members: [
    { id: 1, hostId: 1, priority: 0, host: { id: 1, ipv6: "2001:db8::1" } },
    { id: 2, hostId: 2, priority: 1, host: { id: 2, ipv4: "198.51.100.2", ipv6: "2001:db8::2" } },
  ] };
  const api = entryResolvers();
  assert.deepEqual(api.getForwardGroupEntryAddresses(group).map((row: any) => row.value), [group.domain]);
  assert.deepEqual(api.getForwardGroupEntryAddresses(group, true).map((row: any) => row.value), [group.domain, "2001:db8::2"]);
});

test("chain alternatives come from the entry group and never later relay members", () => {
  const entryGroup = { id: 10, groupMode: "entry", domain: "chain.example.com", members: [
    { hostId: 1, host: { id: 1, ipv6: "2001:db8::1" } },
    { hostId: 2, host: { id: 2, ipv6: "2001:db8::2" }, isEnabled: false },
  ] };
  const chain = { groupMode: "chain", entryGroupId: 10, members: [
    { hostId: 3, host: { id: 3, ipv6: "2001:db8::3" } },
  ] };
  const api = entryResolvers([], [entryGroup]);
  assert.deepEqual(api.getForwardChainEntryAddresses(chain).map((row: any) => row.value), [entryGroup.domain]);
  assert.deepEqual(api.getForwardChainEntryAddresses(chain, true).map((row: any) => row.value), [entryGroup.domain, "2001:db8::1"]);
});
