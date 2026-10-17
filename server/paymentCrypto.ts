import crypto, { type KeyObject } from "node:crypto";
import { PAYMENT_ERRORS, isPaymentCryptoError } from "../shared/paymentErrors";

type SigningProvider = "alipay" | "wxpay";

export class PaymentConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "PaymentConfigurationError"; }
}

export class PaymentKeyConfigurationError extends Error {
  constructor(provider: SigningProvider, kind: "PrivateKey" | "PublicKey", cause?: unknown) {
    super(PAYMENT_ERRORS[`${provider}${kind}`], { cause });
    this.name = "PaymentKeyConfigurationError";
  }
}

function normalizeKey(value: string) {
  return value.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function decodeDer(value: string) {
  const base64 = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("Invalid key encoding");
  return Buffer.from(base64, "base64");
}

function requireRsa(key: KeyObject) {
  // RSA2 is RSA/SHA-256, not an EC or RSA-PSS-only key.
  if (key.asymmetricKeyType !== "rsa") throw new Error("An RSA key is required");
  return key;
}

export function importPaymentPrivateKey(value: string, provider: SigningProvider) {
  try {
    const key = normalizeKey(value);
    if (key.startsWith("-----")) {
      if (!/^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----\n[\s\S]+\n-----END \1-----$/.test(key)) {
        throw new Error("Expected one unencrypted private key");
      }
      return requireRsa(crypto.createPrivateKey(key));
    }
    const der = decodeDer(key);
    // Headerless Alipay keys may be either PKCS#8 or PKCS#1. Import DER
    // explicitly rather than attaching a potentially incorrect PEM label.
    try { return requireRsa(crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" })); }
    catch { return requireRsa(crypto.createPrivateKey({ key: der, format: "der", type: "pkcs1" })); }
  } catch (cause) {
    throw new PaymentKeyConfigurationError(provider, "PrivateKey", cause);
  }
}

export function importPaymentPublicKey(value: string, provider: SigningProvider) {
  try {
    const key = normalizeKey(value);
    if (key.startsWith("-----")) {
      // createPublicKey also accepts private keys; explicitly reject them
      // here so an accidentally pasted application private key is not saved.
      if (!/^-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY|CERTIFICATE)-----\n[\s\S]+\n-----END \1-----$/.test(key)) {
        throw new Error("Expected one public key or certificate");
      }
      return requireRsa(crypto.createPublicKey(key));
    }
    const der = decodeDer(key);
    const readPublicDer = (type: "spki" | "pkcs1") => {
      const result = requireRsa(crypto.createPublicKey({ key: der, format: "der", type }));
      // OpenSSL can derive a public key even from DER private-key input.
      // Require the original data to actually be a public-key encoding.
      if (!result.export({ format: "der", type }).equals(der)) throw new Error("Expected public-key DER");
      return result;
    };
    try { return readPublicDer("spki"); }
    catch { return readPublicDer("pkcs1"); }
  } catch (cause) {
    throw new PaymentKeyConfigurationError(provider, "PublicKey", cause);
  }
}

export function paymentOrderFailureMessage(error: unknown) {
  if (error instanceof PaymentKeyConfigurationError) return error.message;
  if (error instanceof PaymentConfigurationError) return error.message;
  const failure = error as { message?: string; code?: string; name?: string; cause?: { code?: string } } | null;
  const message = String(failure?.message || "");
  if (isPaymentCryptoError(message)) return PAYMENT_ERRORS.keyConfiguration;
  if (/配置不完整/.test(message)) return PAYMENT_ERRORS.configuration;
  const code = failure?.code || failure?.cause?.code || "";
  if (failure?.name === "TimeoutError" || failure?.name === "AbortError" || message === "GM Pay 请求超时"
    || /^(?:ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(code)) return PAYMENT_ERRORS.timeout;
  if (/^(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/.test(code)
    || message === "fetch failed") return PAYMENT_ERRORS.network;
  // Never send arbitrary gateway HTML, OpenSSL codes or internal exceptions
  // to customers. Provider details remain in the order failure log.
  return PAYMENT_ERRORS.unavailable;
}
