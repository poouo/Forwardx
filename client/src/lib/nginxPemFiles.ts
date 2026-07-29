export const MAX_NGINX_PEM_BYTES = 64 * 1024;
export const MAX_NGINX_PEM_UPLOAD_BYTES = MAX_NGINX_PEM_BYTES * 2;
export const MAX_NGINX_PEM_FILES = 2;

export type NginxPemFileContent = {
  name: string;
  content: string;
};

export type ParsedNginxPemFiles = {
  certPem?: string;
  certKeyPem?: string;
  certificateCount: number;
};

const CERTIFICATE_BLOCK_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
const SUPPORTED_PRIVATE_KEY_LABELS = new Set([
  "PRIVATE KEY",
  "RSA PRIVATE KEY",
  "EC PRIVATE KEY",
  "DSA PRIVATE KEY",
]);

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function normalizePemBlock(value: string) {
  return value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

function pemPayloadIsDer(block: string) {
  const lines = block.split("\n");
  if (lines.length < 3) return false;
  const payload = lines.slice(1, -1).join("").replace(/\s/g, "");
  if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return false;

  try {
    const binary = globalThis.atob(payload);
    if (binary.length < 2 || binary.charCodeAt(0) !== 0x30) return false;
    const lengthByte = binary.charCodeAt(1);
    if (lengthByte < 0x80) return lengthByte + 2 === binary.length;
    const lengthBytes = lengthByte & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || binary.length < lengthBytes + 2) return false;
    let contentLength = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      contentLength = (contentLength * 256) + binary.charCodeAt(index + 2);
    }
    return contentLength + lengthBytes + 2 === binary.length;
  } catch {
    return false;
  }
}

function uniquePemBlocks(blocks: string[]) {
  return Array.from(new Set(blocks.map(normalizePemBlock)));
}

export function parseNginxPemFiles(files: readonly NginxPemFileContent[]): ParsedNginxPemFiles {
  if (files.length === 0) throw new Error("请选择证书或私钥文件");
  if (files.length > MAX_NGINX_PEM_FILES) throw new Error("一次最多选择一个证书链文件和一个私钥文件");

  const totalBytes = files.reduce((total, file) => total + utf8ByteLength(file.content), 0);
  if (totalBytes > MAX_NGINX_PEM_UPLOAD_BYTES) throw new Error("所选文件总大小不能超过 128KB");

  const certificateBlocks: string[] = [];
  const privateKeyBlocks: string[] = [];
  let certificateFileCount = 0;

  for (const file of files) {
    const name = String(file.name || "未命名文件");
    const content = normalizePemBlock(file.content);
    const certificates = Array.from(content.matchAll(CERTIFICATE_BLOCK_PATTERN), (match) => match[0])
      .filter(pemPayloadIsDer);
    const privateKeyMatches = Array.from(content.matchAll(PRIVATE_KEY_BLOCK_PATTERN));
    const unsupportedPrivateKey = privateKeyMatches.find((match) => !SUPPORTED_PRIVATE_KEY_LABELS.has(match[1]));
    if (unsupportedPrivateKey) {
      const keyLabel = unsupportedPrivateKey[1];
      if (keyLabel === "ENCRYPTED PRIVATE KEY") {
        throw new Error(`${name} 是加密私钥，Nginx 隧道不支持交互输入密码`);
      }
      throw new Error(`${name} 使用不受支持的 ${keyLabel} 格式`);
    }
    if (privateKeyMatches.some((match) => /Proc-Type:\s*4,ENCRYPTED/i.test(match[0]))) {
      throw new Error(`${name} 是加密私钥，Nginx 隧道不支持交互输入密码`);
    }
    const privateKeys = privateKeyMatches.map((match) => match[0]).filter(pemPayloadIsDer);

    if (certificates.length === 0 && privateKeys.length === 0) {
      throw new Error(`${name} 中未找到有效内容，仅支持 PEM 编码的证书或未加密私钥`);
    }

    if (certificates.length > 0) certificateFileCount += 1;
    certificateBlocks.push(...certificates);
    privateKeyBlocks.push(...privateKeys);
  }

  if (certificateFileCount > 1) {
    throw new Error("证书链请按服务器证书在前的顺序合并到一个 PEM 文件后上传");
  }

  const uniqueCertificates = uniquePemBlocks(certificateBlocks);
  const uniquePrivateKeys = uniquePemBlocks(privateKeyBlocks);
  if (uniquePrivateKeys.length > 1) {
    throw new Error("检测到多个不同的私钥，请仅选择当前证书对应的私钥");
  }

  const certPem = uniqueCertificates.length > 0 ? uniqueCertificates.join("\n") : undefined;
  const certKeyPem = uniquePrivateKeys[0];
  if (certPem && utf8ByteLength(certPem) > MAX_NGINX_PEM_BYTES) {
    throw new Error("证书内容不能超过 64KB");
  }
  if (certKeyPem && utf8ByteLength(certKeyPem) > MAX_NGINX_PEM_BYTES) {
    throw new Error("私钥内容不能超过 64KB");
  }

  return {
    certPem,
    certKeyPem,
    certificateCount: uniqueCertificates.length,
  };
}
