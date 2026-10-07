import { isDiscordSnowflake } from "./discordIdentity";

export async function validateDiscordBotToken(token: string) {
  // Validate before saving: a failed token must not replace a working bot.
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Discord Token 校验失败 (HTTP ${response.status})，原配置未修改`);
  const user = await response.json() as any;
  if (!user?.bot || !isDiscordSnowflake(user.id)) throw new Error("请配置 Discord Bot Token，而不是用户 Token 或 Webhook");
  return { id: user.id as string, username: String(user.username || "") };
}
