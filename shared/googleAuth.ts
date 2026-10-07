export const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";

export const GOOGLE_AUTH_MESSAGES = {
  disabled: "Google 登录尚未启用或配置不完整",
  invalid_state: "Google 登录已过期或浏览器 Cookie 不匹配，请重新发起登录",
  cancelled: "已取消 Google 授权",
  provider_error: "Google 验证失败，请检查服务器能否访问 Google 及客户端配置",
  invalid_identity: "Google 身份验证失败，请重新登录",
  registration_closed: "当前注册未开放，请先登录已有账户绑定 Google",
  existing_account: "该邮箱已有账户，请先使用原方式登录，在个人中心绑定 Google",
  email_not_allowed: "该邮箱不符合面板的注册白名单要求",
  account_disabled: "当前账户已被禁用，请联系管理员",
  already_bound: "该 Google 账户已绑定其他用户，或当前用户已绑定其他 Google 账户",
  session_expired: "原登录会话已失效，请重新登录后绑定 Google",
  rate_limited: "Google 登录操作过于频繁，请稍后重试",
  failed: "Google 登录未完成，请重试或使用密码登录",
} as const;
export type GoogleAuthErrorCode = keyof typeof GOOGLE_AUTH_MESSAGES;

export function googleAuthMessage(code: string | null | undefined) {
  return code && Object.prototype.hasOwnProperty.call(GOOGLE_AUTH_MESSAGES, code)
    ? GOOGLE_AUTH_MESSAGES[code as GoogleAuthErrorCode] : GOOGLE_AUTH_MESSAGES.failed;
}
