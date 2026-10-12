import { t as translateText } from "@/i18n";
import {
  AVATAR_MAX_BYTES,
  BUILTIN_AVATARS,
  builtinAvatarPath,
  builtinAvatarValue,
  getAvatarDataUrlByteLength,
  isAvataaarsValue,
  isMultiavatarValue,
  isValidAvatarValue,
  migrateLegacyAvatarValue,
  randomBuiltinAvatarValue,
} from "@shared/avatar";

export {
  AVATAR_MAX_BYTES,
  BUILTIN_AVATARS,
  builtinAvatarPath,
  builtinAvatarValue,
  getAvatarDataUrlByteLength,
  isAvataaarsValue,
  isMultiavatarValue,
  isValidAvatarValue,
  migrateLegacyAvatarValue,
  randomBuiltinAvatarValue,
};

export function avatarSrc(value?: string | null, fallback?: string | number | null) {
  const text = String(value || "").trim();
  if (text.startsWith("data:image/") && isValidAvatarValue(text)) return text;
  return builtinAvatarPath(text, fallback);
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
    throw new Error(translateText("仅支持 PNG、JPG、WebP 或 GIF 图片"));
  }

  const original = await readAsDataUrl(file);
  if (file.size <= maxBytes && getAvatarDataUrlByteLength(original) <= maxBytes) {
    return original;
  }

  if (/image\/gif/i.test(file.type)) {
    throw new Error(translateText("GIF 超过 50K，无法自动压缩"));
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

  throw new Error(translateText("图片压缩后仍超过 50K"));
}
