import { getSetting } from "./repositories/settingsRepository";
import { normalizeAuthCaptchaProvider } from "../shared/authCaptcha";

export async function getAuthCaptchaConfig() {
  const [enabled, provider] = await Promise.all([
    getSetting("authCaptchaEnabled"), getSetting("authCaptchaProvider"),
  ]);
  return { enabled: enabled !== "false", provider: normalizeAuthCaptchaProvider(provider) };
}
