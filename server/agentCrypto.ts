/**
 * Agent <-> 面板 通讯加密模块（AES-256-CTR + HMAC-SHA256）
 *
 * 选用 CTR + HMAC（Encrypt-then-MAC）的原因：
 *   - openssl 命令行对 AES-GCM 的 tag 输出在 1.1.x 行为不一致，bash 端难以可靠实现
 *   - CTR 与 HMAC 均为 openssl 多年稳定支持的原语，bash 端用一行管道即可完成
 *
 * 协议：
 *   key_enc = SHA-256(token | "forwardx-agent-v1")        // 32 bytes，AES-256-CTR 密钥
 *   key_mac = SHA-256(token | "forwardx-agent-mac")       // 32 bytes，HMAC-SHA256 密钥
 *   iv      = 16 bytes 随机
 *   ct      = AES-256-CTR(key_enc, iv, plaintext_utf8)
 *   mac     = HMAC-SHA256(key_mac, "v1" || iv || ct || ts_bytes_8)
 *   信封    = { v:1, iv:<hex>, ct:<hex>, mac:<hex>, ts:<unix_ms> }
 *
 *   防重放：服务器对比 ts，超过 ±5 分钟拒绝
 *   关联消息：HMAC 把 iv/ct/ts 都覆盖，篡改任一字段即失败
 *   标识方式：HTTP 头 X-Agent-Encrypted: 1
 */
import crypto from "crypto";

const KEY_SALT_ENC = "forwardx-agent-v1";
const KEY_SALT_MAC = "forwardx-agent-mac";
const IV_LEN = 16;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function deriveEncKey(token: string): Buffer {
  return crypto.createHash("sha256").update(`${token}|${KEY_SALT_ENC}`).digest();
}

function deriveMacKey(token: string): Buffer {
  return crypto.createHash("sha256").update(`${token}|${KEY_SALT_MAC}`).digest();
}

export interface EncryptedEnvelope {
  v: number;
  iv: string;  // hex
  ct: string;  // hex
  mac: string; // hex
  ts: number;  // unix ms
}

export function isEncryptedEnvelope(body: any): body is EncryptedEnvelope {
  return (
    body && typeof body === "object" &&
    body.v === 1 &&
    typeof body.iv === "string" &&
    typeof body.ct === "string" &&
    typeof body.mac === "string" &&
    typeof body.ts === "number"
  );
}

function macInput(iv: Buffer, ct: Buffer, ts: number): Buffer {
  const tsBuf = Buffer.alloc(8);
  // 写入 64 位毫秒大端
  tsBuf.writeBigUInt64BE(BigInt(ts));
  return Buffer.concat([Buffer.from("v1"), iv, ct, tsBuf]);
}

/** 加密一段 JSON 可序列化数据 */
export function encryptPayload(payload: any, token: string): EncryptedEnvelope {
  const keyEnc = deriveEncKey(token);
  const keyMac = deriveMacKey(token);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-ctr", keyEnc, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const ts = Date.now();
  const mac = crypto.createHmac("sha256", keyMac).update(macInput(iv, ct, ts)).digest();
  return {
    v: 1,
    iv: iv.toString("hex"),
    ct: ct.toString("hex"),
    mac: mac.toString("hex"),
    ts,
  };
}

/** 解密信封；解密失败抛错 */
export function decryptPayload(envelope: EncryptedEnvelope, token: string): any {
  const keyEnc = deriveEncKey(token);
  const keyMac = deriveMacKey(token);
  const iv = Buffer.from(envelope.iv, "hex");
  const ct = Buffer.from(envelope.ct, "hex");
  const macReceived = Buffer.from(envelope.mac, "hex");
  if (iv.length !== IV_LEN) throw new Error("Invalid IV length");

  if (Math.abs(Date.now() - envelope.ts) > REPLAY_WINDOW_MS) {
    throw new Error("Request timestamp out of window (replay protection)");
  }

  const macExpected = crypto.createHmac("sha256", keyMac).update(macInput(iv, ct, envelope.ts)).digest();
  if (macExpected.length !== macReceived.length || !crypto.timingSafeEqual(macExpected, macReceived)) {
    throw new Error("MAC verification failed");
  }

  const decipher = crypto.createDecipheriv("aes-256-ctr", keyEnc, iv);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}
