import {
  AVATAR_MAX_BYTES,
  AVATAR_PRESET_PREFIX,
  DEFAULT_AVATAR_SEEDS,
  avatarPreset,
  getAvatarDataUrlByteLength,
  isAvatarPreset,
  isValidAvatarValue,
} from "@shared/avatar";

export {
  AVATAR_MAX_BYTES,
  DEFAULT_AVATAR_SEEDS,
  avatarPreset,
  getAvatarDataUrlByteLength,
  isValidAvatarValue,
};

const backgrounds = ["#0ea5e9", "#14b8a6", "#f97316", "#a855f7", "#e11d48", "#22c55e", "#6366f1", "#f59e0b"];
const accents = ["#ffffff", "#fef3c7", "#dbeafe", "#fce7f3", "#ecfeff", "#f0fdf4"];

function hashSeed(seed: string) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pick<T>(items: T[], hash: number, shift = 0) {
  return items[(hash >>> shift) % items.length];
}

function svgToDataUrl(svg: string) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function avatarSeedFromValue(value?: string | null, fallback?: string | number | null) {
  const raw = String(value || "");
  if (raw.startsWith(AVATAR_PRESET_PREFIX)) return raw.slice(AVATAR_PRESET_PREFIX.length);
  return String(fallback || "user");
}

export function renderPresetAvatar(seed: string) {
  const normalized = avatarSeedFromValue(seed);
  const hash = hashSeed(normalized);
  const bg = pick(backgrounds, hash);
  const accent = pick(accents, hash, 5);
  const bg2 = pick(backgrounds, hash, 11);
  const eyeY = 41 + (hash % 6);
  const mouthY = 66 + ((hash >>> 3) % 5);
  const radius = 34 + ((hash >>> 6) % 8);
  const mouth = (hash >>> 9) % 2 === 0
    ? `<path d="M39 ${mouthY}c7 7 19 7 26 0" fill="none" stroke="#172554" stroke-width="5" stroke-linecap="round"/>`
    : `<path d="M40 ${mouthY}c6 4 18 4 24 0" fill="none" stroke="#172554" stroke-width="5" stroke-linecap="round"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 104 104"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${bg}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs><rect width="104" height="104" rx="52" fill="url(#g)"/><circle cx="52" cy="54" r="${radius}" fill="${accent}" opacity=".92"/><circle cx="40" cy="${eyeY}" r="5" fill="#172554"/><circle cx="64" cy="${eyeY}" r="5" fill="#172554"/>${mouth}<path d="M24 26c10-10 24-13 38-9 10 3 17 9 23 18-16-6-36-6-61-9z" fill="#fff" opacity=".22"/></svg>`;
  return svgToDataUrl(svg);
}

export function avatarSrc(value?: string | null, fallback?: string | number | null) {
  const text = String(value || "").trim();
  if (text && !isAvatarPreset(text)) return text;
  return renderPresetAvatar(text || avatarPreset(String(fallback || "user")));
}

export function avatarInitial(user?: { username?: string | null; name?: string | null } | null) {
  return String(user?.name || user?.username || "U").trim().charAt(0).toUpperCase() || "U";
}

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image load failed"));
    image.src = dataUrl;
  });
}

function canvasToDataUrl(canvas: HTMLCanvasElement, type: string, quality: number) {
  return canvas.toDataURL(type, quality);
}

export async function fileToImageDataUrl(file: File, maxBytes = AVATAR_MAX_BYTES) {
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
    throw new Error("仅支持 PNG、JPG、WebP 或 GIF 图片");
  }

  const original = await readAsDataUrl(file);
  if (file.size <= maxBytes && getAvatarDataUrlByteLength(original) <= maxBytes) {
    return original;
  }

  if (/image\/gif/i.test(file.type)) {
    throw new Error("GIF 超过 50K，无法自动压缩");
  }

  const image = await loadImage(original);
  let maxSide = 192;
  let quality = 0.86;
  const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";

  for (let attempt = 0; attempt < 18; attempt += 1) {
    const ratio = Math.min(1, maxSide / Math.max(image.width, image.height));
    const width = Math.max(32, Math.round(image.width * ratio));
    const height = Math.max(32, Math.round(image.height * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const next = canvasToDataUrl(canvas, outputType, quality);
    if (getAvatarDataUrlByteLength(next) <= maxBytes) return next;
    if (quality > 0.55) quality -= 0.08;
    else maxSide = Math.max(48, Math.floor(maxSide * 0.82));
  }

  throw new Error("图片压缩后仍超过 50K");
}
