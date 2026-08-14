import crypto from "crypto";

// Keep the same scrypt work for unknown accounts as for existing accounts.
// This prevents login timing from revealing whether a username is registered.
const DUMMY_PASSWORD_HASH = "00000000000000000000000000000000:9d861075585ee1229b2ddb8ca08518bafea87a1bd9325f2ae25a4238d89a0b347a57f4a1363c6b6c14534c90e7b5a2840f77a842fc850dbd1e2ad583dbdc1aa7";

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try {
    const expected = Buffer.from(hash, "hex");
    const testHash = crypto.scryptSync(password, salt, 64);
    return expected.length === testHash.length && crypto.timingSafeEqual(expected, testHash);
  } catch {
    return false;
  }
}

export function verifyPasswordAgainstDummy(password: string): boolean {
  return verifyPassword(password, DUMMY_PASSWORD_HASH);
}
