import { t } from "@/i18n";
import { mobileAuth } from "./mobileAuth";
import { sanitizeDownloadFilename } from "./fileDownload";

export async function requestBillingExport(
  userId?: number,
  signal?: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
  auth = mobileAuth,
) {
  const query = userId === undefined ? "" : `?userId=${encodeURIComponent(userId)}`;
  const headers = new Headers();
  if (auth.isNative) {
    headers.set("x-forwardx-mobile", "1");
    if (auth.getToken()) headers.set("Authorization", `Bearer ${auth.getToken()}`);
  }
  const response = await fetcher(`${auth.isNative ? auth.getPanelUrl() : ""}/api/billing/ledger.xlsx${query}`, {
    credentials: "include", headers, signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(t(data?.error || "账单导出失败，请稍后重试"));
  }
  if (!response.headers.get("content-type")?.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) {
    throw new Error(t("账单导出失败，请稍后重试"));
  }
  const disposition = response.headers.get("content-disposition") || "";
  const name = disposition.match(/filename="([^"]+)"/i)?.[1];
  return {
    blob: await response.blob(),
    filename: sanitizeDownloadFilename(name || `forwardx-billing-${new Date().toISOString().slice(0, 10)}.xlsx`),
  };
}
