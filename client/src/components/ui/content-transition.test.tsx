import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act, useEffect, useState } from "react";
import { Window } from "happy-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getQueryKey, httpBatchLink } from "@trpc/react-query";
import superjson from "superjson";
import { ContentTransition } from "./content-transition";
import MotionPolicy from "../MotionPolicy";
import { trpc } from "@/lib/trpc";

test("content switches preserve controls and cancel superseded motion without a blank frame", async () => {
  const window = new Window({ url: "http://localhost" });
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const userKey = getQueryKey(trpc.auth.me, undefined, "query");
  queryClient.setQueryData(userKey, { id: 1, animationsEnabled: true });
  const client = trpc.createClient({ links: [httpBatchLink({ url: "http://localhost/api/trpc", transformer: superjson })] });
  const animations: { frames: Keyframe[]; cancelled: boolean; onfinish: (() => void) | null }[] = [];
  let mounts = 0;
  let unmounts = 0;
  function Controls() {
    const [count, setCount] = useState(0);
    useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
    return <><input aria-label="Search" defaultValue="" /><button onClick={() => setCount(count + 1)}>{count}</button></>;
  }
  const render = async (key: string, label = "Ready") => {
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}><trpc.Provider client={client} queryClient={queryClient}>
        <MotionPolicy><ContentTransition transitionKey={key}>
          <h2>{label}</h2><Controls />
        </ContentTransition></MotionPolicy>
      </trpc.Provider></QueryClientProvider>,
    ));
  };
  try {
    await render("entries");
    const panel = container.querySelector<HTMLDivElement>("[data-content-transition]")!;
    panel.animate = ((frames: Keyframe[]) => {
      const animation = { frames, cancelled: false, onfinish: null as (() => void) | null, cancel() { this.cancelled = true; } };
      animations.push(animation);
      return animation;
    }) as unknown as typeof panel.animate;
    const input = container.querySelector("input")!;
    input.value = "Keep my search";
    input.focus();
    await act(async () => container.querySelector("button")!.click());

    await render("exits", "Exit groups");
    assert.equal(container.querySelector("[data-content-transition]"), panel);
    assert.equal(container.querySelector("input"), input);
    assert.equal(document.activeElement, input);
    assert.equal(input.value, "Keep my search");
    assert.equal(container.querySelector("button")!.textContent, "1");
    assert.equal(mounts, 1);
    assert.equal(unmounts, 0);
    assert.equal(container.querySelector("h2")!.textContent, "Exit groups", "new content is available immediately");
    assert.equal(animations.length, 1);
    assert.ok(animations[0].frames.every(frame => frame.opacity === undefined));

    await render("exits", "Fresh data");
    assert.equal(animations.length, 1, "background data refresh does not replay motion");
    await render("entries");
    assert.equal(animations[0].cancelled, true, "rapid switches cancel previous motion");
    assert.equal(animations.length, 2);
    animations[1].onfinish!();
    assert.equal(animations[1].cancelled, true, "finished motion releases its transform");

    await act(async () => {
      queryClient.setQueryData(userKey, { id: 1, animationsEnabled: false });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await render("ports");
    assert.equal(animations.length, 2, "disabled motion switches content without animation");
    assert.equal(container.querySelector("input"), input);
    assert.equal(unmounts, 0);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("shared tab motion stays opaque and query state is excluded from transition keys", () => {
  const css = readFileSync("client/src/index.css", "utf8");
  const keyframes = css.slice(css.indexOf("@keyframes forwardx-tab-enter"), css.indexOf("@keyframes forwardx-card-enter"));
  assert.match(keyframes, /translateY\(4px\)/);
  assert.doesNotMatch(keyframes, /opacity/);
  for (const path of ["client/src/index.css", "client/src/styles/pearl.css"]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /\.tab-content-enter\[data-state="active"\]\s*\{\s*animation: forwardx-tab-enter 180ms/);
  }
  for (const [page, key] of [["Rules", "ruleContentTransitionKey"], ["Tunnels", "activeSectionTransitionKey"], ["ForwardGroups", "contentTransitionKey"]]) {
    const source = readFileSync(`client/src/pages/${page}.tsx`, "utf8");
    const declaration = source.match(new RegExp(`const ${key} = ([^;]+);`))?.[1];
    assert.ok(declaration, page);
    assert.doesNotMatch(declaration, /loading|isLoading|isError|empty|\.length/, page);
  }
});
