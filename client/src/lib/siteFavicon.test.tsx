import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ForwardXLogo from "../components/ForwardXLogo";
import { FORWARDX_LOGO, defaultLogoSvg, logoSecondaryColor } from "./brandLogo";
import { applySiteFavicon, siteFavicon } from "./siteFavicon";

test("favicon and page logo share geometry, gradient and theme color", () => {
  const component = renderToStaticMarkup(<ForwardXLogo />);
  const svg = defaultLogoSvg("#123456");
  for (const output of [component, svg]) {
    assert.ok(output.includes(FORWARDX_LOGO.body));
    assert.ok(output.includes(FORWARDX_LOGO.chevron));
    assert.ok(output.includes(`rx="${FORWARDX_LOGO.radius}"`));
    assert.ok(output.includes('fill-opacity="0.95"'));
  }
  assert.ok(svg.includes(logoSecondaryColor("#123456")));
  assert.match(svg, /stop-color="#123456"/);
  assert.ok(!svg.includes("var(--primary"), "external SVG cannot inherit page CSS variables");
  assert.notEqual(siteFavicon("", "#123456").href, siteFavicon("", "#abcdef").href);
  assert.doesNotMatch(defaultLogoSvg('#000"/><script>bad</script>'), /<script>/);
});

test("uploaded logos take priority and retain the correct MIME type", () => {
  for (const type of ["png", "jpeg", "webp", "gif"]) {
    const logo = `data:image/${type};base64,dGVzdA==`;
    assert.deepEqual(siteFavicon(logo, "#123456"), { href: logo, type: `image/${type}`, svg: false });
    assert.equal(siteFavicon(logo, "#abcdef").href, logo);
  }
  for (const invalid of [null, undefined, "", "javascript:alert(1)", "https://example.com/icon.png"]) {
    assert.equal(siteFavicon(invalid, "#123456").svg, true);
  }
});

function fakeDocument() {
  const nodes: any[] = [];
  let created = 0;
  const doc = {
    querySelectorAll: () => nodes.filter(node => node.rel.split(/\s+/).includes("icon")),
    createElement: () => {
      created++;
      const node: any = { rel: "", type: "", attributes: new Map(),
        setAttribute(key: string, value: string) { this.attributes.set(key, value); },
        getAttribute(key: string) { return this.attributes.get(key); },
        remove() { nodes.splice(nodes.indexOf(this), 1); },
      };
      return node;
    },
    head: { appendChild: (node: any) => nodes.push(node) },
  };
  return { doc: doc as unknown as Document, nodes, created: () => created };
}

test("replace competing favicon candidates, refresh changed images, restore themed default and avoid churn", () => {
  const { doc, nodes, created } = fakeDocument();
  for (const rel of ["icon", "shortcut icon", "apple-touch-icon"]) {
    const node = doc.createElement("link"); node.rel = rel; doc.head.appendChild(node);
  }
  applySiteFavicon(doc, "", "#123456");
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].rel, "apple-touch-icon");
  assert.equal(nodes[1].id, "forwardx-site-favicon");
  assert.equal(nodes[1].getAttribute("sizes"), "any");
  const initial = nodes[1];
  const before = created();
  applySiteFavicon(doc, "", "#123456");
  assert.equal(created(), before);
  assert.equal(nodes[1], initial);
  const logo = "data:image/png;base64,dGVzdA==";
  applySiteFavicon(doc, logo, "#123456");
  assert.notEqual(nodes[1], initial);
  assert.equal(nodes[1].getAttribute("href"), logo);
  assert.equal(nodes[1].type, "image/png");
  assert.equal(nodes[1].getAttribute("sizes"), undefined);
  applySiteFavicon(doc, null, "#abcdef");
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1].type, "image/svg+xml");
  assert.ok(decodeURIComponent(nodes[1].getAttribute("href")).includes("#abcdef"));
});
