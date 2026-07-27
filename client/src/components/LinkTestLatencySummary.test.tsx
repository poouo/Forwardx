import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { handoffManualTestResult } from "@/lib/manualTestCache";
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

test("a completed manual test replaces the inactive cache before the query key switches", () => {
  type Result = { id: number; latencyMs: number };
  const cache = new Map<boolean, Result>([
    [false, { id: 1, latencyMs: 47 }],
    [true, { id: 2, latencyMs: 63 }],
  ]);
  let includeActive = true;
  const visibleLatencies: number[] = [cache.get(includeActive)!.latencyMs];

  const handedOff = handoffManualTestResult(
    cache.get(true),
    (result) => cache.set(false, result),
    () => {
      includeActive = false;
      visibleLatencies.push(cache.get(includeActive)!.latencyMs);
    },
  );

  assert.equal(handedOff, true);
  assert.deepEqual(visibleLatencies, [63, 63]);
});

test("a missing manual test result cannot end the probing state", () => {
  let finished = false;
  const handedOff = handoffManualTestResult(
    null,
    () => assert.fail("missing results must not populate the completed cache"),
    () => { finished = true; },
  );

  assert.equal(handedOff, false);
  assert.equal(finished, false);
});
