import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import AuthorSupportDialog, { AUTHOR_SUPPORT_ADDRESSES, AuthorSupportAddresses } from "./AuthorSupportDialog";

test("author support retains the exact network/address pairs in both READMEs", () => {
  assert.equal(AUTHOR_SUPPORT_ADDRESSES.length, 4);
  for (const file of ["README.md", "README.en.md"]) {
    const readme = readFileSync(file, "utf8");
    for (const item of AUTHOR_SUPPORT_ADDRESSES) {
      assert.ok(readme.split(/\r?\n/).some(line => line.startsWith(item.network) && line.includes(`\`${item.address}\``)), `${file}: ${item.network}`);
    }
  }
});

test("support entry uses a real dialog button rather than an external payment link", () => {
  const html = renderToStaticMarkup(<AuthorSupportDialog onCopy={() => {}} />);
  assert.match(html, /type="button"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /赞助作者/);
  assert.match(html, /给作者充点克劳德/);
  assert.doesNotMatch(html, /href=|<form/);
});

test("wallet list wraps long addresses and labels every copy button by network", () => {
  const html = renderToStaticMarkup(<AuthorSupportAddresses onCopy={() => {}} />);
  assert.equal((html.match(/type="button"/g) || []).length, 4);
  assert.equal((html.match(/<code /g) || []).length, 4);
  assert.match(html, /select-text break-all/);
  for (const item of AUTHOR_SUPPORT_ADDRESSES) {
    assert.ok(html.includes(item.address));
    assert.ok(html.includes(`aria-label="复制地址 · ${item.network}"`));
  }
});

test("Settings places support in the contact grid and reuses the existing clipboard fallback", () => {
  const source = readFileSync("client/src/pages/Settings.tsx", "utf8");
  assert.match(source, /contactLinks\.map\([\s\S]*?<AuthorSupportDialog onCopy=\{copyTextToClipboard\} \/>/);
  const translations = JSON.parse(readFileSync("client/src/i18n/en.json", "utf8"));
  for (const key of ["赞助作者", "给作者充点克劳德", "复制地址", "请确认币种与网络后再转账。"]) {
    assert.equal(typeof translations[key], "string");
  }
});
