// Native icon assets are generated from the same theme palette and logo paths as the web UI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { APP_ICON_VARIANTS, DEFAULT_APP_ICON } from "../shared/appIcons";
import { FORWARDX_LOGO, defaultLogoSvg, logoSecondaryColor } from "../client/src/lib/brandLogo";

const root = fileURLToPath(new URL("../", import.meta.url));

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

/** Encode RGB, not RGBA: Apple rejects even fully opaque icons with an alpha channel. */
export function opaquePng(pixels: Uint8Array, width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  if (pixels.length !== width * height * 4) throw new Error("Invalid RGBA dimensions");
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4, target = y * (width * 3 + 1) + 1 + x * 3;
      if (pixels[source + 3] !== 255) throw new Error("iOS icon must be fully opaque");
      rows[target] = pixels[source];
      rows[target + 1] = pixels[source + 1];
      rows[target + 2] = pixels[source + 2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** Convert our OKLCH theme tokens to sRGB for native renderers without CSS Color 4 support. */
export function nativeColors(value: string) {
  const match = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (!match) throw new Error(`Unsupported theme color: ${value}`);
  const [L, C, degrees] = match.slice(1).map(Number);
  const angle = degrees * Math.PI / 180;
  const a = C * Math.cos(angle), b = C * Math.sin(angle);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(v => Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)) * 255);
  const hex = (rgb: number[]) => `#${rgb.map(v => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  return { primary: hex(channels), secondary: hex(channels.map((v, i) => v * 0.7 + [13, 148, 136][i] * 0.3)) };
}

export function nativeIconSvg(primaryToken: string, round = false) {
  const { primary, secondary } = nativeColors(primaryToken);
  return defaultLogoSvg(primary)
    .replace(logoSecondaryColor(primary), secondary)
    .replace(`rx="${FORWARDX_LOGO.radius}"`, `rx="${round ? FORWARDX_LOGO.radius : 0}"`);
}

function write(relative: string, content: string | Uint8Array) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && fs.readFileSync(target).equals(Buffer.from(content))) return;
  fs.writeFileSync(target, content);
}

export function generateAppIcons() {
  const res = "android/app/src/main/res";
  const vectorHeader = `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">`;
  const foreground = `${vectorHeader}
  <group android:translateX="24" android:translateY="24" android:scaleX="0.5" android:scaleY="0.5">
    <path android:fillColor="#FFFFFF" android:pathData="${FORWARDX_LOGO.body}"/>
    <path android:fillColor="#B7F6DB" android:fillAlpha="0.95" android:pathData="${FORWARDX_LOGO.chevron}"/>
  </group>
</vector>\n`;
  write(`${res}/drawable/ic_launcher_foreground.xml`, foreground);
  write(`${res}/drawable/ic_launcher_monochrome.xml`, foreground.replace('#B7F6DB', '#FFFFFF'));
  for (const variant of APP_ICON_VARIANTS) {
    const isDefault = variant.key === DEFAULT_APP_ICON;
    const resource = isDefault ? "ic_launcher" : `ic_launcher_${variant.key.replace(/-/g, "_")}`;
    const colors = nativeColors(variant.primary);
    write(`${res}/drawable/${resource}_theme_background.xml`, `${vectorHeader}
  <path android:pathData="M0,0 H108 V108 H0 Z">
    <aapt:attr xmlns:aapt="http://schemas.android.com/aapt" name="android:fillColor">
      <gradient android:startX="0" android:startY="0" android:endX="108" android:endY="108" android:startColor="${colors.primary}" android:endColor="${colors.secondary}" android:type="linear"/>
    </aapt:attr>
  </path>
</vector>\n`);
    const adaptive = (monochrome: boolean) => `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@drawable/${resource}_theme_background"/>
  <foreground android:drawable="@drawable/ic_launcher_foreground"/>
${monochrome ? '  <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n' : ''}</adaptive-icon>\n`;
    for (const version of [26, 33]) {
      write(`${res}/mipmap-anydpi-v${version}/${resource}.xml`, adaptive(version === 33));
      if (isDefault) write(`${res}/mipmap-anydpi-v${version}/ic_launcher_round.xml`, adaptive(version === 33));
    }
    for (const [density, size] of [["mdpi", 48], ["hdpi", 72], ["xhdpi", 96], ["xxhdpi", 144], ["xxxhdpi", 192]] as const) {
      const png = new Resvg(nativeIconSvg(variant.primary, true), { fitTo: { mode: "width", value: size } }).render().asPng();
      write(`${res}/mipmap-${density}/${resource}.png`, png);
      if (isDefault) write(`${res}/mipmap-${density}/ic_launcher_round.png`, png);
    }
    const catalog = `ios/App/App/Assets.xcassets/${isDefault ? "AppIcon" : variant.name}.appiconset`;
    // Opaque, full-bleed PNG: iOS supplies its own rounded mask.
    const image = new Resvg(nativeIconSvg(variant.primary), { fitTo: { mode: "width", value: 1024 } }).render();
    write(`${catalog}/AppIcon-512@2x.png`, opaquePng(image.pixels, image.width, image.height));
    write(`${catalog}/Contents.json`, JSON.stringify({
      images: [{ filename: "AppIcon-512@2x.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
      info: { author: "xcode", version: 1 },
    }, null, 2) + "\n");
  }
  console.log(`Generated ${APP_ICON_VARIANTS.length} themed Android/iOS icon variants`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateAppIcons();
