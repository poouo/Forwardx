export const AUTH_CAPTCHA_PROVIDERS = ["cap", "image"] as const;
export type AuthCaptchaProvider = typeof AUTH_CAPTCHA_PROVIDERS[number];

/** Missing/invalid persisted settings retain the current verification method. */
export function normalizeAuthCaptchaProvider(value: unknown): AuthCaptchaProvider {
  return value === "image" ? "image" : "cap";
}
