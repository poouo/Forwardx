import assert from "node:assert/strict";
import test from "node:test";
import {
  isSafeCustomSidebarIconDataUrl,
  normalizeCustomSidebarPages,
  visibleCustomSidebarPages,
} from "../shared/customSidebarPages";

function svgDataUrl(svg: string) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

test("custom sidebar pages normalize URLs, duplicate IDs, and role visibility", () => {
  const pages = normalizeCustomSidebarPages([
    { id: "status", name: " Status ", url: "https://status.example.com", visibility: "all" },
    { id: "status", name: "Duplicate", url: "https://duplicate.example.com", visibility: "admin" },
    { id: "admin", name: "Admin", url: "http://10.0.0.2:9000/ui", visibility: "admin" },
    { id: "unsafe", name: "Unsafe", url: "javascript:alert(1)", visibility: "all" },
  ]);

  assert.deepEqual(pages.map((page) => [page.id, page.name, page.visibility]), [
    ["status", "Status", "all"],
    ["admin", "Admin", "admin"],
  ]);
  assert.deepEqual(visibleCustomSidebarPages(pages, "user").map((page) => page.id), ["status"]);
  assert.deepEqual(visibleCustomSidebarPages(pages, "admin").map((page) => page.id), ["status", "admin"]);
});

test("custom sidebar SVG icons reject active content and external resources", () => {
  const safe = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M2 2h20v20H2z"/></svg>');
  const script = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const external = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://example.com/a.svg#x)" d="M0 0h1v1z"/></svg>');

  assert.equal(isSafeCustomSidebarIconDataUrl(safe), true);
  assert.equal(isSafeCustomSidebarIconDataUrl(script), false);
  assert.equal(isSafeCustomSidebarIconDataUrl(external), false);
});
