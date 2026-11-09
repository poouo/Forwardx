/** Reset secrets travel in the fragment so proxies and access logs never see
 * them. Keep only in memory and remove them from browser history immediately. */
export function takePasswordRecoveryToken(location: Pick<Location, "hash" | "pathname" | "search">, history: Pick<History, "replaceState" | "state">) {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = params.get("password-reset");
  if (token === null) return null;
  params.delete("password-reset");
  const hash = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`);
  return token.length <= 2048 ? token : "";
}
