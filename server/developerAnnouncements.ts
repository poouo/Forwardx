import { DEVELOPER_ANNOUNCEMENT_INTERVAL_MS, developerAnnouncementFeedSchema, developerAnnouncementReadKey,
  developerAnnouncementReadKeySchema, eligibleDeveloperAnnouncements, type DeveloperAnnouncement } from "../shared/developerAnnouncements";
import { githubDownloadCandidates, type GithubAcceleratorConfig } from "../shared/githubAccelerator";
import { getSetting, getSettings, setSetting } from "./repositories/settingsRepository";
import { withKeyedTaskLock } from "./keyedTaskLock";

export const DEVELOPER_ANNOUNCEMENT_URL = "https://raw.githubusercontent.com/poouo/Forwardx/main/announcements/developer.json";
const MAX_FEED_BYTES = 128 * 1024;
const MAX_STALE_MS = 24 * 60 * 60_000;

export async function readDeveloperAnnouncementFeed(response: Response) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  if (Number(response.headers.get("content-length")) > MAX_FEED_BYTES) {
    await response.body?.cancel(); throw new Error("Announcement feed too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Announcement feed empty");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) throw new Error("Announcement feed too large");
      chunks.push(value);
    }
    return developerAnnouncementFeedSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).announcements;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** One shared fetch per panel, including failures; never runs on startup or inside SQL transactions. */
export function createDeveloperAnnouncementCache(options: {
  fetcher?: typeof fetch; now?: () => number;
  accelerator?: () => Promise<GithubAcceleratorConfig>;
  warn?: (message: string) => void;
} = {}) {
  let items: DeveloperAnnouncement[] = [], loadedAt: number | null = null, nextCheck = 0;
  let pending: Promise<DeveloperAnnouncement[]> | undefined;
  const now = options.now ?? Date.now;
  const available = () => loadedAt !== null && now() - loadedAt < MAX_STALE_MS ? structuredClone(items) : [];
  async function refresh() {
    try {
      const accelerator = options.accelerator ? await options.accelerator() : undefined;
      // One total deadline covers proxy fallback, response headers and body reads.
      const signal = AbortSignal.timeout(8000);
      let lastError: unknown;
      for (const url of githubDownloadCandidates(DEVELOPER_ANNOUNCEMENT_URL, accelerator)) {
        try {
          const response = await (options.fetcher ?? fetch)(url, { signal, redirect: "error", cache: "no-store",
            headers: { Accept: "application/json", "Cache-Control": "no-cache", "User-Agent": "ForwardX-Developer-Announcements" } });
          items = await readDeveloperAnnouncementFeed(response);
          loadedAt = now();
          return available();
        } catch (error) { lastError = error; if (signal.aborted) break; }
      }
      throw lastError;
    } catch {
      // Do not log proxy URLs, SQL details or one stack trace per browser poll.
      (options.warn ?? console.warn)("[Announcement] Developer feed unavailable; retaining recent cache; next administrator visit may retry after 30 minutes");
      return available();
    } finally { nextCheck = now() + DEVELOPER_ANNOUNCEMENT_INTERVAL_MS; }
  }
  return {
    async get() {
      if (pending) return structuredClone(await pending);
      if (now() < nextCheck) return available();
      pending = refresh();
      try { return structuredClone(await pending); } finally { pending = undefined; }
    },
  };
}

const feed = createDeveloperAnnouncementCache({ accelerator: async () => {
  const settings = await getSettings(["githubAcceleratorEnabled", "githubAcceleratorUrl"]);
  return { enabled: settings.githubAcceleratorEnabled === "true", url: settings.githubAcceleratorUrl };
} });
const readSettingsKey = (userId: number) => `developer-announcements-read:${userId}`;
function parseReadKeys(raw: string | null) {
  if (!raw || raw.length > 30000) return [] as string[];
  try {
    const values = JSON.parse(raw);
    return Array.isArray(values) ? values.filter((key): key is string => developerAnnouncementReadKeySchema.safeParse(key).success).slice(-200) : [];
  } catch { return []; }
}
export async function getUnreadDeveloperAnnouncement(userId: number, installedVersion: string) {
  const items = eligibleDeveloperAnnouncements(await feed.get(), installedVersion);
  if (!items.length) return null;
  const read = new Set(parseReadKeys(await getSetting(readSettingsKey(userId))));
  return items.find(item => !read.has(developerAnnouncementReadKey(item))) ?? null;
}
export async function dismissDeveloperAnnouncement(userId: number, readKey: string) {
  developerAnnouncementReadKeySchema.parse(readKey);
  await withKeyedTaskLock(readSettingsKey(userId), async () => {
    const previous = parseReadKeys(await getSetting(readSettingsKey(userId)));
    await setSetting(readSettingsKey(userId), JSON.stringify([...new Set([...previous, readKey])].slice(-200)));
  });
}
