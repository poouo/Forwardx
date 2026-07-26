import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

const pkg = JSON.parse(read("package.json"));
const versionsTs = read("shared/versions.ts");
const agentMain = read("agent/main.go");
const fxpMain = read("forwardx-fxp/main.go");
const changelog = read("CHANGELOG.md");

const findTsConst = (name) => {
  const match = versionsTs.match(new RegExp(`export const ${name}\\s*=\\s*["']([^"']+)["']`));
  if (!match) throw new Error(`${name} not found in shared/versions.ts`);
  return match[1];
};

const appVersion = findTsConst("APP_VERSION");
const androidAppVersion = findTsConst("ANDROID_APP_VERSION");
const androidApkReleaseVersion = findTsConst("ANDROID_APK_RELEASE_VERSION");
const agentVersion = findTsConst("AGENT_VERSION");
const agentMainVersion = agentMain.match(/var Version\s*=\s*"([^"]+)"/)?.[1];
const fxpRuntimeVersion = fxpMain.match(/fxpRuntimeVersion\s*=\s*"([^"]+)"/)?.[1];

const semverPattern = /^\d+\.\d+\.\d+$/;
const parseSemver = (version) => version.split(".").map(Number);
const isExpectedVersionStep = (previous, current) => {
  const [previousMajor, previousMinor, previousPatch] = parseSemver(previous);
  const [currentMajor, currentMinor, currentPatch] = parseSemver(current);
  if (currentMajor === previousMajor && currentMinor === previousMinor) {
    return currentPatch === previousPatch || currentPatch === previousPatch + 1;
  }
  if (currentMajor === previousMajor && currentMinor === previousMinor + 1) {
    return currentPatch === 0;
  }
  return currentMajor === previousMajor + 1 && currentMinor === 0 && currentPatch === 0;
};

const changelogHeading = new RegExp(`^## \\[${appVersion.replace(/\./g, "\\.")}\\][^\\n]*\\n`, "m");
const changelogMatch = changelogHeading.exec(changelog);
const changelogSectionStart = changelogMatch ? changelogMatch.index + changelogMatch[0].length : -1;
const changelogAfterCurrent = changelogSectionStart >= 0 ? changelog.slice(changelogSectionStart) : "";
const nextChangelogHeading = changelogAfterCurrent.search(/^## \[/m);
const currentChangelogSection = changelogSectionStart >= 0
  ? (nextChangelogHeading >= 0 ? changelogAfterCurrent.slice(0, nextChangelogHeading) : changelogAfterCurrent)
  : "";
const olderChangelog = nextChangelogHeading >= 0 ? changelogAfterCurrent.slice(nextChangelogHeading) : "";
const fxpVersionPattern = /ForwardX FXP runtime[^\n`]*`v?(\d+\.\d+\.\d+)`/i;
const changelogFxpVersion = currentChangelogSection.match(fxpVersionPattern)?.[1];
const previousFxpVersion = olderChangelog.match(fxpVersionPattern)?.[1];

const releaseTag = (
  process.env.FORWARDX_RELEASE_TAG
  || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "")
  || (process.env.GITHUB_REF?.startsWith("refs/tags/") ? process.env.GITHUB_REF.slice("refs/tags/".length) : "")
  || ""
).trim();

const errors = [];
if (pkg.version !== appVersion) {
  errors.push(`package.json version ${pkg.version} does not match APP_VERSION ${appVersion}`);
}
if (androidApkReleaseVersion !== appVersion) {
  errors.push(`ANDROID_APK_RELEASE_VERSION ${androidApkReleaseVersion} does not match APP_VERSION ${appVersion}`);
}
if (agentMainVersion !== agentVersion) {
  errors.push(`agent/main.go Version ${agentMainVersion || "(missing)"} does not match AGENT_VERSION ${agentVersion}`);
}
if (!fxpRuntimeVersion) {
  errors.push("fxpRuntimeVersion not found in forwardx-fxp/main.go");
} else if (!semverPattern.test(fxpRuntimeVersion)) {
  errors.push(`FXP runtime version ${fxpRuntimeVersion} must use x.y.z format`);
}
if (appVersion === agentVersion) {
  errors.push(`APP_VERSION and AGENT_VERSION are both ${appVersion}; keep panel and Agent version lines separate`);
}
for (const [name, version] of [
  ["APP_VERSION", appVersion],
  ["ANDROID_APP_VERSION", androidAppVersion],
  ["ANDROID_APK_RELEASE_VERSION", androidApkReleaseVersion],
  ["AGENT_VERSION", agentVersion],
]) {
  if (!semverPattern.test(version)) errors.push(`${name} ${version} must use x.y.z format`);
}
if (!changelogMatch) {
  errors.push(`CHANGELOG section for APP_VERSION ${appVersion} was not found`);
} else if (!changelogFxpVersion) {
  errors.push(`CHANGELOG section ${appVersion} does not declare the ForwardX FXP runtime version`);
} else if (fxpRuntimeVersion && changelogFxpVersion !== fxpRuntimeVersion) {
  errors.push(`CHANGELOG FXP runtime version ${changelogFxpVersion} does not match forwardx-fxp/main.go ${fxpRuntimeVersion}`);
}
if (
  fxpRuntimeVersion
  && semverPattern.test(fxpRuntimeVersion)
  && previousFxpVersion
  && !isExpectedVersionStep(previousFxpVersion, fxpRuntimeVersion)
) {
  errors.push(`FXP runtime version ${fxpRuntimeVersion} must stay at ${previousFxpVersion} or advance by one semantic version step`);
}
if (releaseTag && releaseTag !== `v${appVersion}`) {
  errors.push(`release tag ${releaseTag} does not match APP_VERSION v${appVersion}`);
}
if (errors.length) {
  console.error(errors.map((line) => `- ${line}`).join("\n"));
  process.exit(1);
}

console.log(`versions ok: panel=${appVersion} android=${androidAppVersion} apkRelease=${androidApkReleaseVersion} agent=${agentVersion} fxp=${fxpRuntimeVersion}${releaseTag ? ` tag=${releaseTag}` : ""}`);
