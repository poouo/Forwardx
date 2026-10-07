// Snowflakes must stay strings: Number loses precision. Early Discord accounts
// may have shorter IDs; validate the unsigned 64-bit range, not a modern length.
export function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
}
