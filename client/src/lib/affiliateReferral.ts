const KEY = "forwardx.referral";
const MAX_AGE = 30 * 86400_000;
// randomUUID is unavailable on ordinary HTTP panels; getRandomValues still works.
export function affiliateRequestKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function captureAffiliateReferral(
  search: string,
  storage: Pick<Storage, "setItem"> = localStorage,
) {
  const code = new URLSearchParams(search).get("ref");
  if (!code || !/^[a-zA-Z0-9]{6,32}$/.test(code)) return;
  try {
    storage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    /* Optional attribution must not block login. */
  }
}
export function getAffiliateReferral(
  storage: Pick<Storage, "getItem" | "removeItem"> = localStorage,
): string | undefined {
  try {
    const value = JSON.parse(storage.getItem(KEY) || "null");
    if (
      value &&
      /^[a-zA-Z0-9]{6,32}$/.test(value.code) &&
      Number.isFinite(value.at) &&
      Date.now() - value.at >= 0 &&
      Date.now() - value.at <= MAX_AGE
    )
      return value.code;
    storage.removeItem(KEY);
  } catch {
    /* Corrupt or unavailable browser storage. */
  }
  return undefined;
}
export function clearAffiliateReferral() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* Optional storage. */
  }
}
