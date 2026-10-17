import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ForwardGroupMembers } from "./ForwardGroupMembers";
import { PortEntryRuntimeSummary } from "./PortEntryRuntimeSummary";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "../i18n";

const members = [1, 2, 3].map(id => ({ id, label: `入口 · host-${id}`, active: id === 1, title: `node-${id}` }));

test("entry group uses the shared route member layout without inventing hop or failover roles", () => {
  const html = renderToStaticMarkup(<ForwardGroupMembers title="入口主机" entryGroupName="香港入口" members={members}><PortEntryRuntimeSummary summary={{ expectedHostCount: 3, runningHostCount: 1, nodes: [] }} /></ForwardGroupMembers>);
  assert.match(html, /入口组.*香港入口/);
  for (const member of members) assert.ok(html.includes(member.label));
  assert.match(html, /text-emerald-600/);
  assert.match(html, /节点详情/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /<details|<summary/);
  assert.doesNotMatch(html, /主备|中转|出口|→|min-w-\[/);
});

test("compact table preview limits chips and preserves hidden member names", () => {
  const html = renderToStaticMarkup(<ForwardGroupMembers title="入口主机" entryGroupName="入口组" members={members} compact />);
  assert.match(html, /\+1/);
  assert.match(html, /title="入口 · host-3"/);
  assert.doesNotMatch(html, />入口 · host-3<|bg-muted\/25 p-2.5/);
  assert.match(renderToStaticMarkup(<ForwardGroupMembers title="入口主机" members={[]} />), /暂无成员/);
});

test("shared member labels support English without translating user group names", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en");
    await initializeLanguage();
    const html = renderToStaticMarkup(<ForwardGroupMembers title="Entry hosts" entryGroupName="用户自定义名称" members={[]} />);
    assert.match(html, /Entry Group/);
    assert.match(html, /用户自定义名称/);
    assert.doesNotMatch(html, /暂无成员|入口组/);
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});
