import { t } from "./index";
import { isPaymentCryptoError } from "../../../shared/paymentErrors";

// Some existing API responses use English instead of the catalog's Chinese
// source text. Normalize only known, exact messages at the presentation layer;
// do not change API errors, match arbitrary substrings, or translate diagnostics.
const messageAliases: Readonly<Record<string, string>> = {
  "User not found": "用户不存在",
  "renewal order requires a plan": "续费订单需要选择套餐",
  "subscription does not exist or is not owned by this user": "订阅不存在或不属于当前用户",
  "renewal plan does not match the target subscription": "续费套餐与当前订阅不一致",
  "cancelled subscriptions cannot be renewed": "已取消的订阅不能续费",
  "administrator-assigned subscriptions must be renewed by an administrator": "管理员分配的订阅需由管理员续费",
};

export function translateNotificationText(message: string): string {
  const source = Object.hasOwn(messageAliases, message) ? messageAliases[message] : message;
  const amount = /^(最低|最高)支付金额为 (\d+(?:\.\d+)?)$/.exec(source);
  if (amount) return t(amount[1] === "最低" ? "最低支付金额为 {0}" : "最高支付金额为 {0}", [amount[2]]);
  return t(source);
}

// Only normalize recognizable low-level errors in error toasts. Logs, custom
// Agent/plugin output and user-defined content are not rewritten.
export function translateErrorNotificationText(message: string): string {
  if (isPaymentCryptoError(message)) return t("密钥或证书无法解析，请检查格式或联系管理员查看日志。");
  if (/^(?:fetch failed|Failed to fetch|NetworkError when attempting to fetch resource\.|Load failed)$/.test(message)) {
    return t("网络请求失败，请检查连接后重试。");
  }
  if (/^(?:Unknown error|Internal server error|INTERNAL_SERVER_ERROR)$/i.test(message)) {
    return t("操作失败，请稍后重试或联系管理员查看日志。");
  }
  return translateNotificationText(message);
}
