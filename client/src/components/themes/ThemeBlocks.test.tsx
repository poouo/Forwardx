import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import ThemeBlocks from "./ThemeBlocks";
import { LoginLayout } from "../LoginLayout";
import { THEME_FIELDS } from "@shared/themeFields";
import english from "@/i18n/en.json";

test("theme field rendering escapes values, preserves zero, hides unavailable fields and bounds progress", () => {
  const html = renderToStaticMarkup(<ThemeBlocks node={{ type: "group", direction: "grid", columns: { mobile: 1, desktop: 3 }, children: [
    { type: "field", field: "host.name", label: "<label>" },
    { type: "field", field: "host.cpuUsage", display: "progress" },
    { type: "field", field: "host.memoryUsage", when: "available" },
    { type: "text", text: "<script>alert(1)</script>", when: "offline" },
  ] }} values={{ "host.online": true, "host.name": '<img src=x onerror="alert(1)">', "host.cpuUsage": 0, "host.memoryUsage": null }} />);
  assert.doesNotMatch(html, /<img|<script|host.memoryUsage/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;label&gt;/);
  assert.match(html, /0%/);
  assert.match(html, /--theme-columns-desktop:3/);
  const over = renderToStaticMarkup(<ThemeBlocks node={{ type: "field", field: "host.cpuUsage", display: "progress" }} values={{ "host.cpuUsage": 150 }} />);
  assert.match(over, /150%/);
  assert.match(over, /aria-valuenow="100"/);
  assert.match(over, /width:100%/);
});

test("custom login copy and content keep the real authentication form slot", () => {
  const html = renderToStaticMarkup(<Router ssrPath="/login"><LoginLayout siteTitle="My Site" mode="login" subtitle="Original subtitle" toolbar={<button>Theme</button>}
    themeConfig={{ layout: "reversed", loginTitle: "My Login", loginSubtitle: "Sign in here", hero: { type: "field", field: "site.title", label: false }, beforeForm: { type: "text", text: "<script>alert(1)</script>" } }}>
    <form><input name="username" /><button type="submit">Submit</button></form>
  </LoginLayout></Router>);
  assert.match(html, /data-theme-login-layout="reversed"/);
  assert.match(html, /My Login/);
  assert.match(html, /Sign in here/);
  assert.match(html, /name="username"/);
  assert.match(html, /type="submit"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /data-theme-field="site.title"/);
});

test("the theme field directory has translated labels", () => {
  const missing = Object.values(THEME_FIELDS).map(field => field.label).filter(label => /\p{Script=Han}/u.test(label) && !Object.hasOwn(english, label));
  assert.deepEqual([...new Set(missing)], []);
});
