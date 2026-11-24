import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeHtml } from "./htmlSanitizer";

test("sanitizes external announcement images while keeping useful attributes", () => {
  const html = sanitizeHtml('<p>News</p><img src="https://cdn.example.com/news.png" alt="Release image" title="Release" onerror="alert(1)">');

  assert.match(html, /<img src="https:\/\/cdn\.example\.com\/news\.png" alt="Release image" title="Release"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /decoding="async"/);
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(html, /onerror|alert/);
});

test("rejects unsafe image sources without affecting surrounding announcement text", () => {
  const html = sanitizeHtml('<p>Before</p><img src="javascript:alert(1)" alt="bad"><img src="data:image/png;base64,AAAA" alt="also bad"><p>After</p>');

  assert.match(html, /<p>Before<\/p>/);
  assert.match(html, /<p>After<\/p>/);
  assert.doesNotMatch(html, /javascript:|data:image|<img/);
});
