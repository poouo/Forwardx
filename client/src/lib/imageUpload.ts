export type CompressedImageResult = {
  dataUrl: string;
  size: number;
  width: number;
  height: number;
};

function dataUrlBytes(dataUrl: string) {
  const marker = ";base64,";
  const markerIndex = dataUrl.indexOf(marker);
  if (markerIndex < 0) return new TextEncoder().encode(dataUrl).length;
  const base64 = dataUrl.slice(markerIndex + marker.length).replace(/\s/g, "");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解析失败"));
    image.src = url;
  });
}

function canvasToDataUrl(canvas: HTMLCanvasElement, type: string, quality: number): string {
  return canvas.toDataURL(type, quality);
}

export async function compressImageFile(
  file: File,
  options: {
    maxBytes: number;
    maxSide?: number;
    preferredType?: "image/webp" | "image/jpeg" | "image/png";
    minQuality?: number;
  },
): Promise<CompressedImageResult> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");

  const original = await fileToDataUrl(file);
  if (file.size <= options.maxBytes && original.length <= options.maxBytes * 1.5) {
    const image = await loadImage(original);
    return { dataUrl: original, size: file.size, width: image.naturalWidth, height: image.naturalHeight };
  }

  const image = await loadImage(original);
  const maxSide = options.maxSide || 2560;
  let scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const minQuality = options.minQuality ?? 0.58;
  const outputType = options.preferredType || (file.type === "image/png" ? "image/png" : "image/jpeg");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持图片压缩");
    ctx.drawImage(image, 0, 0, width, height);

    for (let quality = 0.88; quality >= minQuality; quality -= 0.08) {
      const dataUrl = canvasToDataUrl(canvas, outputType, quality);
      const size = dataUrlBytes(dataUrl);
      if (size <= options.maxBytes) return { dataUrl, size, width, height };
    }

    scale *= 0.82;
  }

  throw new Error("图片压缩后仍超过限制，请换一张更小的图片");
}

export function imageDataUrlSize(dataUrl: string) {
  return dataUrlBytes(dataUrl);
}
