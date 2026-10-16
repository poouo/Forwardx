// Stable source messages for payment failures; localized at the UI boundary.
export const PAYMENT_ERRORS = {
  alipayPrivateKey: "支付宝应用私钥无效，请填写 RSA 私钥（PKCS#1 或 PKCS#8），不要填写公钥或证书。",
  alipayPublicKey: "支付宝公钥无效，请填写 RSA 公钥，不要填写应用私钥。",
  wxpayPrivateKey: "微信支付商户私钥无效，请填写未加密的 RSA 私钥（PKCS#1 或 PKCS#8）。",
  wxpayPublicKey: "微信支付公钥或证书无效，请检查平台公钥或平台证书。",
  keyConfiguration: "支付签名密钥无法解析，请联系管理员检查支付渠道的 RSA 私钥格式。",
  configuration: "支付渠道配置不完整，请联系管理员检查支付设置。",
  network: "无法连接支付服务，请稍后重试；如持续失败请联系管理员。",
  timeout: "支付服务响应超时，请稍后重试。",
  unavailable: "创建支付订单失败，请稍后重试或联系管理员查看支付日志。",
} as const;

export function isPaymentCryptoError(message: string) {
  return /^error:[0-9a-f]+:(?:DECODER|PEM|ASN1|asn1 encoding|digital envelope) routines:/i.test(message)
    || /^ERR_OSSL_(?:UNSUPPORTED|PEM_|ASN1_)/.test(message);
}
