import assert from "node:assert/strict";
import test from "node:test";
import { markdownToHtml, renderMixedHtml } from "./htmlContent";

test("markdown links keep underscores in href attributes", () => {
  const html = markdownToHtml("[my_site_x.com](https://example.com/my_site_x.com)");

  assert.match(html, /href="https:\/\/example\.com\/my_site_x\.com"/);
  assert.match(html, />my<em>site<\/em>x\.com<\/a>/);
});

test("markdown links keep asterisks in href attributes", () => {
  const html = markdownToHtml("[download](https://example.com/file*name.tar.gz)");

  assert.match(html, /href="https:\/\/example\.com\/file\*name\.tar\.gz"/);
});

test("markdown images render as safe external images", () => {
  const html = renderMixedHtml('![Release image](https://cdn.example.com/release.png "Release")');

  assert.match(html, /<img src="https:\/\/cdn\.example\.com\/release\.png" alt="Release image" title="Release"/);
  assert.doesNotMatch(html, /<a href/);
});

test("markdown images reject unsafe sources", () => {
  const html = renderMixedHtml("![unsafe](javascript:alert(1))");

  assert.doesNotMatch(html, /<img/);
});
