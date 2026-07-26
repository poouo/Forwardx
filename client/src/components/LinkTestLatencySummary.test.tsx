import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LinkTestProbeView, parseLinkTestMessage } from "./LinkTestLatencySummary";

const plannedSegments = [{ from: "入口节点", to: "出口节点" }];

test("an unopened link test waits instead of claiming that a probe is running", () => {
  const html = renderToStaticMarkup(
    <LinkTestProbeView
      parsed={parseLinkTestMessage(null)}
      isSuccess={false}
      isTesting={false}
      plannedSegments={plannedSegments}
    />,
  );

  assert.match(html, /等待探测/);
  assert.doesNotMatch(html, /探测中/);
});

test("the last reported latency remains visible before a new manual probe", () => {
  const html = renderToStaticMarkup(
    <LinkTestProbeView
      parsed={parseLinkTestMessage(null)}
      fallbackLatencyMs={42}
      isSuccess
      isTesting={false}
      plannedSegments={plannedSegments}
    />,
  );

  assert.match(html, /42 ms/);
  assert.doesNotMatch(html, /等待探测|探测中/);
});

test("a user-started link test is the only state rendered as probing", () => {
  const html = renderToStaticMarkup(
    <LinkTestProbeView
      parsed={parseLinkTestMessage(null)}
      isSuccess={false}
      isTesting
      plannedSegments={plannedSegments}
    />,
  );

  assert.match(html, /探测中/);
  assert.doesNotMatch(html, /等待探测/);
});
