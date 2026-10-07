import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));

export function readIOSVersion(source = fs.readFileSync(path.join(root, "shared/versions.ts"), "utf8")) {
  const version = source.match(/export const IOS_APP_VERSION\s*=\s*["'](\d+\.\d+\.\d+)["']/)?.[1];
  if (!version) throw new Error("IOS_APP_VERSION must use x.y.z format");
  return version;
}

export function iosBuildArguments(version, derivedData) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid iOS version");
  return [
    "-project", "ios/App/App.xcodeproj", "-scheme", "App",
    "-configuration", "Release", "-sdk", "iphoneos",
    "-destination", "generic/platform=iOS", "-derivedDataPath", derivedData,
    "ARCHS=arm64", "ONLY_ACTIVE_ARCH=NO", "CODE_SIGNING_ALLOWED=NO",
    "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY=", "DEVELOPMENT_TEAM=",
    `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${version}`, "build",
  ];
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || "see build log"}`);
  return result.stdout?.trim() || "";
}

export function buildIOSIPA() {
  if (process.platform !== "darwin") throw new Error("IPA builds require macOS and Xcode. Use GitHub Actions > iOS IPA on Windows/Linux.");
  const version = readIOSVersion();
  run("xcodebuild", ["-version"]);
  // Always sync on the build host: Windows-generated SPM paths are not valid on macOS.
  run("pnpm", ["mobile:sync:ios"]);
  run("plutil", ["-lint", "ios/App/App/Info.plist", "ios/App/App/PrivacyInfo.xcprivacy"]);
  const icon = "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png";
  run("swift", ["scripts/ios-icon.swift", "client/public/logo-light.png", icon]);

  const buildDir = path.join(root, "ios/build");
  fs.mkdirSync(buildDir, { recursive: true });
  // Fresh products prevent a stale .app from being packaged after a failed build.
  const staging = fs.mkdtempSync(path.join(buildDir, "ipa-"));
  const derivedData = path.join(staging, "DerivedData");
  run("xcodebuild", iosBuildArguments(version, derivedData));
  const app = path.join(derivedData, "Build/Products/Release-iphoneos/App.app");
  const plist = path.join(app, "Info.plist");
  const readPlist = (key) => run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], true);
  if (readPlist("CFBundleShortVersionString") !== version || readPlist("CFBundleVersion") !== version) {
    throw new Error("Built app version does not match IOS_APP_VERSION");
  }
  if (readPlist("CFBundleIdentifier") !== "com.forwardx.app" || readPlist("CFBundleSupportedPlatforms:0") !== "iPhoneOS") {
    throw new Error("Expected com.forwardx.app built for a physical iOS device");
  }
  const executable = readPlist("CFBundleExecutable");
  if (path.basename(executable) !== executable) throw new Error("Invalid app executable");
  run("lipo", [path.join(app, executable), "-verify_arch", "arm64"]);
  if (!fs.existsSync(path.join(app, "public/index.html")) || !fs.existsSync(path.join(app, "PrivacyInfo.xcprivacy"))) {
    throw new Error("Built app is missing web assets or privacy manifest");
  }

  const packageDir = path.join(staging, "package");
  fs.mkdirSync(path.join(packageDir, "Payload"), { recursive: true });
  run("ditto", [app, path.join(packageDir, "Payload/App.app")]);
  const name = `forwardx-ios-v${version}-unsigned.ipa`;
  const packed = path.join(staging, name);
  run("ditto", ["-c", "-k", "--norsrc", "--noextattr", packageDir, packed]);
  run("unzip", ["-tq", packed]);
  const entries = run("unzip", ["-Z1", packed], true).split("\n");
  if (!entries.includes("Payload/App.app/Info.plist") || !entries.includes(`Payload/App.app/${executable}`)) {
    throw new Error("IPA archive does not contain the expected Payload");
  }
  const output = path.join(root, "dist/ios");
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(packed, path.join(output, name));
  const hash = createHash("sha256").update(fs.readFileSync(packed)).digest("hex");
  fs.writeFileSync(path.join(output, `${name}.sha256`), `${hash}  ${name}\n`);
  fs.writeFileSync(path.join(output, "README-IOS-SIGNING.txt"),
    "ForwardX iOS IPA (arm64, iOS 15+), unsigned.\nSign with your own certificate/provisioning profile or sideloading tool before installing.\nThis is not an App Store or TestFlight build. No Apple credentials are included.\nUse a trusted HTTPS panel; untrusted TLS certificates are not bypassed.\n");
  console.log(`Unsigned IPA generated: ${path.join(output, name)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--version")) console.log(readIOSVersion());
    else buildIOSIPA();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
