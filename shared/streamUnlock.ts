export const STREAM_UNLOCK_PROBE_VERSION = "2";

export const STREAM_UNLOCK_PROVIDER_CATALOG = [
  { id: "netflix", name: "Netflix", category: "streaming", availabilityOnly: false },
  { id: "disney-plus", name: "Disney+", category: "streaming", availabilityOnly: false },
  { id: "youtube", name: "YouTube", category: "streaming", availabilityOnly: false },
  { id: "spotify", name: "Spotify", category: "streaming", availabilityOnly: false },
  { id: "bilibili-tv", name: "Bilibili TV", category: "streaming", availabilityOnly: false },
  { id: "bahamut", name: "巴哈姆特动画疯", category: "streaming", availabilityOnly: false },
  { id: "abema", name: "AbemaTV", category: "streaming", availabilityOnly: false },
  { id: "tiktok", name: "TikTok", category: "streaming", availabilityOnly: true },
  { id: "gemini", name: "Gemini", category: "ai", availabilityOnly: true },
  { id: "grok", name: "Grok", category: "ai", availabilityOnly: true },
  { id: "chatgpt", name: "ChatGPT", category: "ai", availabilityOnly: true },
  { id: "claude", name: "Claude", category: "ai", availabilityOnly: true },
] as const;

export type StreamUnlockProviderId = (typeof STREAM_UNLOCK_PROVIDER_CATALOG)[number]["id"];
export type StreamUnlockFamily = "ipv4" | "ipv6" | "both";
export type StreamUnlockProviderStatus = "available" | "partial" | "blocked" | "login_required" | "error" | "unknown";
export type StreamUnlockDnsMode = "direct" | "dns_unlocked" | "dns_region_override" | "smart_dns_suspected" | "public_dns" | "mismatch" | "unknown";

export type StreamUnlockProviderResult = {
  providerId: string;
  providerName: string;
  family?: "ipv4" | "ipv6" | string;
  status: StreamUnlockProviderStatus;
  region?: string | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
  detail?: string | null;
  evidence?: string | null;
  checkedAt?: string;
};

export type StreamUnlockDnsResult = {
  domain: string;
  family?: "ipv4" | "ipv6" | string;
  mode: StreamUnlockDnsMode;
  systemAddresses: string[];
  publicAddresses: string[];
  systemCnames?: string[];
  publicCnames?: string[];
  detail?: string | null;
  checkedAt?: string;
};

export type StreamUnlockAgentTask = {
  taskId: string;
  family: StreamUnlockFamily;
  providerIds: string[];
  createdAt: string;
};

export type StreamUnlockAgentResult = {
  taskId: string;
  probeVersion: string;
  family: StreamUnlockFamily;
  exitIPv4?: string | null;
  exitIPv6?: string | null;
  providers: StreamUnlockProviderResult[];
  dns: StreamUnlockDnsResult[];
  startedAt: string;
  finishedAt: string;
  error?: string | null;
};

export type StreamUnlockTaskStatus = "queued" | "running" | "success" | "error" | "timeout";

export type StreamUnlockTaskSnapshot = StreamUnlockAgentResult & {
  hostId: number;
  status: StreamUnlockTaskStatus;
  running?: boolean;
  checkedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export const STREAM_UNLOCK_DEFAULT_PROVIDER_IDS: StreamUnlockProviderId[] = STREAM_UNLOCK_PROVIDER_CATALOG.map((item) => item.id);
