import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { handoffManualTestResult, hasQuerySnapshotAfter } from "@/lib/manualTestCache";
import { getLinkTestDetailEndpointIds, LinkTestProbeView, parseLinkTestMessage } from "./LinkTestLatencySummary";

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

test("a post-mutation query snapshot completes even when the server timestamp is unchanged", () => {
  assert.equal(hasQuerySnapshotAfter(100, 100), false);
  assert.equal(hasQuerySnapshotAfter(100, 101), true);
  assert.equal(hasQuerySnapshotAfter(null, 101), false);
});

test("planned segments keep their latency after a host is renamed", () => {
  const parsed = parseLinkTestMessage(JSON.stringify({
    kind: "tunnel-link-test",
    details: [{
      success: true,
      latencyMs: 17,
      routeLabel: "Old entry -> Old IX",
      fromHostId: 101,
      toHostId: 102,
      hopIndex: 0,
      hopCount: 1,
    }],
    totalLatencyMs: 17,
  }));
  const html = renderToStaticMarkup(
    <LinkTestProbeView
      parsed={parsed}
      isSuccess
      isTesting={false}
      mobileStacked={false}
      plannedSegments={[{
        from: "Renamed entry",
        to: "Renamed IX",
        fromHostId: 101,
        toHostId: 102,
        hopIndex: 0,
        hopCount: 1,
      }]}
    />,
  );

  assert.match(html, /Renamed entry/);
  assert.match(html, /Renamed IX/);
  assert.equal(html.match(/17 ms/g)?.length, 2);
  assert.doesNotMatch(html, /Old entry|Old IX/);
});

test("an unmatched final target is not invented from an earlier hop result", () => {
  const parsed = parseLinkTestMessage(JSON.stringify({
    kind: "forward-group-link-test",
    details: [{
      success: true,
      latencyMs: 23,
      routeLabel: "Entry -> Private IX",
      fromHostId: 201,
      toHostId: 202,
      hopIndex: 0,
      hopCount: 1,
    }],
    totalLatencyMs: 23,
  }));
  const html = renderToStaticMarkup(
    <LinkTestProbeView
      parsed={parsed}
      isSuccess
      isTesting={false}
      mobileStacked={false}
      plannedSegments={[
        {
          from: "Entry",
          to: "Private IX",
          fromHostId: 201,
          toHostId: 202,
          hopIndex: 0,
          hopCount: 1,
        },
        {
          from: "Private IX",
          to: "Public target",
          fromHostId: 202,
          hopIndex: 1,
          hopCount: 2,
        },
      ]}
    />,
  );

  assert.equal(html.match(/23 ms/g)?.length, 2);
  assert.match(html, /Public target/);
  assert.match(html, /等待探测/);
  assert.doesNotMatch(html, />--</);
});

test("a single result from an old topology is not assigned to the new segment", () => {
  const parsed = parseLinkTestMessage(JSON.stringify({
    kind: "tunnel-link-test",
    details: [{
      success: true,
      latencyMs: 19,
      routeLabel: "Old entry -> Old exit",
      fromHostId: 301,
      toHostId: 302,
      hopIndex: 0,
      hopCount: 1,
    }],
    totalLatencyMs: 19,
  }));
  const html = renderToStaticMarkup(
    <LinkTestProbeView
      parsed={parsed}
      isSuccess
      isTesting={false}
      mobileStacked={false}
      plannedSegments={[{
        from: "New entry",
        to: "New exit",
        fromHostId: 401,
        toHostId: 402,
        hopIndex: 0,
        hopCount: 1,
      }]}
    />,
  );

  assert.match(html, /Old entry/);
  assert.match(html, /Old exit/);
  assert.doesNotMatch(html, /New entry|New exit/);
  assert.equal(html.match(/19 ms/g)?.length, 2);
});

test("a null hop index stays unknown instead of becoming the first hop", () => {
  const parsed = parseLinkTestMessage(JSON.stringify({
    details: [{
      success: true,
      latencyMs: 11,
      hopLabel: "出口 -> 目标",
      hopIndex: null,
      hopCount: null,
    }],
  }));

  assert.equal(parsed.details[0]?.hopIndex, null);
  assert.equal(parsed.details[0]?.hopCount, null);
});

test("an explicit endpoint id is not overwritten by a legacy numeric label", () => {
  const parsed = parseLinkTestMessage(JSON.stringify({
    details: [{
      success: true,
      latencyMs: 11,
      fromHostId: 501,
      hopLabel: "1/1 90->91",
    }],
  }));

  assert.deepEqual(getLinkTestDetailEndpointIds(parsed.details[0]), {
    fromHostId: 501,
    toHostId: 91,
    hopIndex: 0,
    hopCount: 1,
  });
});

test("entry and exit ordinals are not parsed as hop indexes", () => {
  const parsed = parseLinkTestMessage(JSON.stringify({
    details: [
      { success: true, latencyMs: 11, hopLabel: "入口 2/2 60->70" },
      { success: true, latencyMs: 12, hopLabel: "出口 2/3 60->80" },
    ],
  }));

  assert.equal(getLinkTestDetailEndpointIds(parsed.details[0]).hopIndex, null);
  assert.equal(getLinkTestDetailEndpointIds(parsed.details[1]).hopIndex, null);
});

test("a legacy endpoint alias cannot attach an old result to a planned host id", () => {
  const parsed = parseLinkTestMessage(JSON.stringify({
    details: [{
      success: true,
      latencyMs: 18,
      routeLabel: "Legacy exit -> Target",
    }],
    totalLatencyMs: 18,
  }));
  const sharedExitMeta = { label: "New exit" };
  const html = renderToStaticMarkup(
    <LinkTestProbeView
      parsed={parsed}
      isSuccess
      isTesting={false}
      mobileStacked={false}
      nodeMeta={{
        "Legacy exit": sharedExitMeta,
        "New exit": sharedExitMeta,
      }}
      plannedSegments={[{
        from: "New exit",
        to: "Target",
        fromHostId: 401,
      }]}
    />,
  );

  assert.match(html, /Legacy exit/);
  assert.doesNotMatch(html, /New exit/);
  assert.equal(html.match(/18 ms/g)?.length, 2);
});

test("a result from a shorter topology cannot populate the retained first edge", () => {
  const parsed = parseLinkTestMessage(JSON.stringify({
    details: [{
      success: true,
      latencyMs: 12,
      routeLabel: "Old A -> Old B",
      fromHostId: 1,
      toHostId: 2,
      hopIndex: 0,
      hopCount: 1,
    }],
    totalLatencyMs: 12,
  }));
  const html = renderToStaticMarkup(
    <LinkTestProbeView
      parsed={parsed}
      isSuccess
      isTesting={false}
      mobileStacked={false}
      plannedSegments={[
        { from: "Current A", to: "Current B", fromHostId: 1, toHostId: 2, hopIndex: 0, hopCount: 2 },
        { from: "Current B", to: "Current C", fromHostId: 2, toHostId: 3, hopIndex: 1, hopCount: 2 },
      ]}
    />,
  );

  assert.match(html, /Old A/);
  assert.match(html, /Old B/);
  assert.doesNotMatch(html, /Current A|Current B|Current C/);
});

test("an entry that has not reported remains visible after a partial multi-entry result", () => {
  const parsed = parseLinkTestMessage(JSON.stringify({
    details: [
      { success: true, latencyMs: 9, routeLabel: "Entry 1 -> IX", fromHostId: 11, toHostId: 20, hopIndex: 0, hopCount: 2 },
      { success: true, latencyMs: 14, routeLabel: "IX -> Exit", fromHostId: 20, toHostId: 30, hopIndex: 1, hopCount: 2 },
    ],
    totalLatencyMs: 23,
  }));
  const html = renderToStaticMarkup(
    <LinkTestProbeView
      parsed={parsed}
      isSuccess
      isTesting={false}
      mobileStacked={false}
      plannedSegments={[
        { from: "Entry 1", to: "IX", fromHostId: 11, toHostId: 20, hopIndex: 0, hopCount: 2 },
        { from: "Entry 2", to: "IX", fromHostId: 12, toHostId: 20, hopIndex: 0, hopCount: 2 },
        { from: "IX", to: "Exit", fromHostId: 20, toHostId: 30, hopIndex: 1, hopCount: 2 },
      ]}
    />,
  );

  assert.match(html, /Entry 1/);
  assert.match(html, /Entry 2/);
  assert.match(html, /Exit/);
  assert.match(html, /等待探测/);
});

test("current rule details discard an older planned tunnel latency fallback", () => {
  const parsed = parseLinkTestMessage(JSON.stringify({
    kind: "forward-via-tunnel",
    details: [{
      success: true,
      latencyMs: 5,
      routeLabel: "Exit -> Target",
      fromHostId: 2,
    }],
    totalLatencyMs: 5,
  }));
  const html = renderToStaticMarkup(
    <LinkTestProbeView
      parsed={parsed}
      fallbackLatencyMs={5}
      isSuccess
      isTesting={false}
      mobileStacked={false}
      ignorePlannedResultsWhenDetailsPresent
      plannedSegments={[
        { from: "Entry", to: "Exit", fromHostId: 1, toHostId: 2, hopIndex: 0, hopCount: 1, success: true, latencyMs: 77 },
        { from: "Exit", to: "Target", fromHostId: 2 },
      ]}
    />,
  );

  assert.match(html, /Entry/);
  assert.match(html, /Exit/);
  assert.match(html, /Target/);
  assert.doesNotMatch(html, /77 ms/);
  assert.equal(html.match(/5 ms/g)?.length, 2);
});

test("a tunnel rule keeps the current tunnel segment when it reconciles with the test total", () => {
  const parsed = parseLinkTestMessage(JSON.stringify({
    kind: "forward-via-tunnel",
    details: [{
      success: true,
      latencyMs: 33,
      routeLabel: "GGY Shanghai -> Ali Shanghai",
      fromHostId: 2,
    }],
    totalLatencyMs: 41,
  }));
  const html = renderToStaticMarkup(
    <LinkTestProbeView
      parsed={parsed}
      fallbackLatencyMs={41}
      isSuccess
      isTesting={false}
      mobileStacked={false}
      ignorePlannedResultsWhenDetailsPresent
      plannedSegments={[
        { from: "Ali Hangzhou", to: "GGY Shanghai", fromHostId: 1, toHostId: 2, hopIndex: 0, hopCount: 1, success: true, latencyMs: 8 },
        { from: "GGY Shanghai", to: "Ali Shanghai", fromHostId: 2 },
      ]}
    />,
  );

  assert.match(html, /Ali Hangzhou/);
  assert.match(html, /GGY Shanghai/);
  assert.match(html, /Ali Shanghai/);
  assert.equal(html.match(/8 ms/g)?.length, 1);
  assert.equal(html.match(/33 ms/g)?.length, 1);
  assert.equal(html.match(/41 ms/g)?.length, 1);
  assert.doesNotMatch(html, /等待探测|探测中/);
});
