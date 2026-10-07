export type MobilePackagePlatform = "android" | "ios";

export function extractMobilePackageVersion(name: string, platform: MobilePackagePlatform) {
  const pattern = platform === "ios"
    ? /^forwardx-ios-v?(\d+\.\d+\.\d+)-unsigned\.ipa$/i
    : /^forwardx-android-v?(\d+\.\d+\.\d+)\.apk$/i;
  return name.match(pattern)?.[1] || null;
}

export function compareMobileVersions(a: string, b: string) {
  const left = a.replace(/^v/i, "").split(".").map(Number);
  const right = b.replace(/^v/i, "").split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

export function latestMobilePackage(releases: unknown, platform: MobilePackagePlatform) {
  const candidates: { version: string; releaseUrl: string }[] = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || release.prerelease || !Array.isArray(release.assets)) continue;
    for (const asset of release.assets) {
      const version = extractMobilePackageVersion(String(asset?.name || ""), platform);
      if (!version) continue;
      candidates.push({ version, releaseUrl: release.html_url || "https://github.com/poouo/Forwardx/releases/latest" });
    }
  }
  return candidates.sort((a, b) => compareMobileVersions(b.version, a.version))[0];
}
