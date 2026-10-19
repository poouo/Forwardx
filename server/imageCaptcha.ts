import { randomInt } from "node:crypto";
import svgCaptcha from "svg-captcha";

const CHARACTERS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Outlined glyphs, not embedded text; the answer never appears in the SVG. */
export function createObfuscatedImageCaptcha(): svgCaptcha.CaptchaObj {
  const text = Array.from({ length: 6 }, () => CHARACTERS[randomInt(CHARACTERS.length)]).join("");
  // svg-captcha's CommonJS default is callable, but its declarations only list
  // named helpers. Supply our cryptographically generated answer explicitly.
  const render = svgCaptcha as unknown as (text: string, options: svgCaptcha.ConfigObject) => string;
  const base = render(text, { width: 224, height: 72, fontSize: 48, noise: 5, color: true, background: "#f8fafc" });
  const seed = randomInt(1, 65536);
  const dots = Array.from({ length: 45 }, () =>
    `<circle cx="${randomInt(3, 222)}" cy="${randomInt(3, 70)}" r="${randomInt(4, 13) / 10}" fill="${["#64748b", "#7c3aed", "#0369a1"][randomInt(3)]}" opacity="0.3"/>`,
  ).join("");
  const paths = base.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")
    .replace(/<path fill="[^"]*"/g, () => `<path transform="translate(${randomInt(-2, 3)} ${randomInt(-4, 5)}) skewX(${randomInt(-3, 4)})" fill="${["#1e3a8a", "#5b21b6", "#155e75", "#9f1239", "#166534"][randomInt(5)]}"`);
  const filter = `<defs><filter id="warp" x="-10%" y="-20%" width="120%" height="140%"><feTurbulence type="fractalNoise" baseFrequency="0.018 0.085" numOctaves="1" seed="${seed}" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="4" xChannelSelector="R" yChannelSelector="G"/></filter></defs>`;
  const foreground = `<path d="M0 ${randomInt(15, 58)} Q112 ${randomInt(2, 70)} 224 ${randomInt(15, 58)}" stroke="#475569" stroke-width="0.8" opacity="0.5" fill="none"/>`;
  return { text, data: `<svg xmlns="http://www.w3.org/2000/svg" width="224" height="72" viewBox="0 0 224 72">${filter}<g filter="url(#warp)">${paths}</g>${dots}${foreground}</svg>` };
}
