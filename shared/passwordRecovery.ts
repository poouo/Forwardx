export type PasswordRecoveryChannel = "email" | "telegram";
export const PASSWORD_RECOVERY_TTL_SECONDS = 15 * 60;
export const PASSWORD_RECOVERY_REQUEST_MESSAGE = "申请已提交。如账号已配置所选找回方式，将收到有效期为 15 分钟的重置链接；未绑定或未验证该方式，请联系管理员。";
export const PASSWORD_RECOVERY_INVALID_MESSAGE = "重置链接无效、已使用或已过期，请重新申请或联系管理员";
