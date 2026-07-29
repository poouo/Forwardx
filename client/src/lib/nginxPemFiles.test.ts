import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { rootCertificates } from "node:tls";
import { MAX_NGINX_PEM_UPLOAD_BYTES, parseNginxPemFiles } from "./nginxPemFiles";

const normalizePem = (value: string) => value.replace(/\r\n?/g, "\n").trim();
const certificateA = normalizePem(rootCertificates[0]);
const certificateB = normalizePem(rootCertificates[1]);
const rsaPrivateKey = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;
const privateKey = normalizePem(rsaPrivateKey.export({ format: "pem", type: "pkcs8" }).toString());

test("parseNginxPemFiles classifies separate certificate and key files", () => {
  const result = parseNginxPemFiles([
    { name: "fullchain.pem", content: `${certificateA}\r\n${certificateB}\r\n` },
    { name: "privkey.pem", content: privateKey },
  ]);

  assert.equal(result.certPem, `${certificateA}\n${certificateB}`);
  assert.equal(result.certKeyPem, privateKey);
  assert.equal(result.certificateCount, 2);
});

test("parseNginxPemFiles accepts a combined PEM and removes duplicate certificates", () => {
  const result = parseNginxPemFiles([
    { name: "combined.pem", content: `${certificateA}\n${privateKey}\n${certificateA}` },
  ]);

  assert.equal(result.certPem, certificateA);
  assert.equal(result.certKeyPem, privateKey);
  assert.equal(result.certificateCount, 1);
});

test("parseNginxPemFiles rejects files without valid PEM blocks", () => {
  assert.throws(
    () => parseNginxPemFiles([{ name: "certificate.txt", content: "not a certificate" }]),
    /仅支持 PEM 编码/,
  );
});

test("parseNginxPemFiles rejects multiple different private keys", () => {
  const secondKey = normalizePem(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  }).toString());
  assert.throws(
    () => parseNginxPemFiles([
      { name: "first.key", content: privateKey },
      { name: "second.key", content: secondKey },
    ]),
    /多个不同的私钥/,
  );
});

test("parseNginxPemFiles rejects oversized upload files", () => {
  assert.throws(
    () => parseNginxPemFiles([{ name: "huge.pem", content: "x".repeat(MAX_NGINX_PEM_UPLOAD_BYTES + 1) }]),
    /总大小不能超过 128KB/,
  );
});

test("parseNginxPemFiles rejects encrypted and OpenSSH private keys", () => {
  const encryptedKey = rsaPrivateKey.export({
    cipher: "aes-256-cbc",
    format: "pem",
    passphrase: "test-only",
    type: "pkcs8",
  }).toString();
  const openSshKey = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "MAMCAQE=",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");

  assert.throws(
    () => parseNginxPemFiles([{ name: "encrypted.key", content: encryptedKey }]),
    /加密私钥/,
  );
  assert.throws(
    () => parseNginxPemFiles([{ name: "id_ed25519", content: openSshKey }]),
    /不受支持的 OPENSSH PRIVATE KEY/,
  );
});

test("parseNginxPemFiles requires an ordered certificate chain in one file", () => {
  assert.throws(
    () => parseNginxPemFiles([
      { name: "server.crt", content: certificateA },
      { name: "intermediate.crt", content: certificateB },
    ]),
    /合并到一个 PEM 文件/,
  );
});

test("parseNginxPemFiles rejects binary CER content with a PEM-specific message", () => {
  assert.throws(
    () => parseNginxPemFiles([{ name: "certificate.cer", content: String.fromCharCode(0x30, 0x03, 0x02, 0x01, 0x01) }]),
    /仅支持 PEM 编码/,
  );
});
