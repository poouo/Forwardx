# 移动客户端（APK / IPA）

ForwardX 移动客户端共用面板的页面和 API。首次打开时填写自己的面板地址，再使用面板账号登录；支持主机监控、规则管理、本地通知和按平台检查应用更新。它是管理客户端，不是 iOS Agent，也不提供 VPN 或本机流量转发服务。

## 下载与安装

- Android：从 [GitHub Releases](https://github.com/poouo/Forwardx/releases/latest) 下载 APK 并安装。
- iOS / iPadOS 15 及以上：下载 `forwardx-ios-v版本-unsigned.ipa`，自行签名后安装。未签名 IPA 不能直接在普通 iPhone / iPad 上安装，需自备签名证书、描述文件或适用的侧载工具。本项目不提供签名服务，也不发布到 App Store / TestFlight。

IPA 旁提供 `.sha256` 校验文件和签名说明。更换签名身份或 Bundle ID 可能影响覆盖安装、数据保留和本地通知，请遵循所用签名工具的要求。应用内更新检查仅跳转下载页面，不会绕过系统安装或签名限制。

## 面板连接

优先使用证书有效、设备信任的 HTTPS 面板地址。兼容用户指定的 HTTP 面板，但 HTTP 不加密登录和管理流量，不建议公网使用。访问局域网面板时，允许 iOS 的“本地网络”权限；拒绝后可在系统设置中重新开启。自签名或过期的 HTTPS 证书不会被绕过。

已有面板服务端支持 `capacitor://localhost` 的跨域请求和移动端 Token 登录，不需要为 iOS 放宽到任意跨域来源。首次开启流量/到期本地提醒时需允许通知权限；未授权不影响基础管理功能。

## 桌面图标与主题

安装支持此功能的新版 APK / IPA 后，桌面 App 图标会跟随面板的六套预设主题及浅色 / 深色模式。打开 App 获取主题、切换配色或返回前台时自动同步；相同主题不重复切换。首次连接面板前使用默认墨色图标，后台不会主动轮询面板。

- Android：通过预置启动入口切换图标，不需要额外权限。部分桌面会延迟更新或重排快捷方式；旧桌面快捷方式若保留旧图标，可移除后从应用列表重新添加。开启系统“主题图标”时，颜色由系统壁纸决定，不保证与面板配色一致。
- iOS / iPadOS：使用系统备用图标接口，仅在 App 前台切换，系统可能显示图标更改提示。重新签名时请保留备用图标资源及相关配置。
- 管理员上传的自定义 Logo 用于 App 内页面和浏览器标签，不会下载为桌面图标；桌面图标仅使用安装包预置的主题版本。
- 仅升级面板服务端不会给旧 App 增加原生能力，需安装更新的客户端。

开发时可运行 `pnpm mobile:icons`，从共用 Logo 几何和主题色重新生成 Android 多密度、自适应 / 单色资源及 iOS 不带透明通道的 1024px 图标；`mobile:sync:android` / `mobile:sync:ios` 会自动执行。`pnpm test:mobile-icons` 校验主题覆盖、资源与切换去重逻辑。

## GitHub 自动构建

仓库提供独立的 **iOS IPA** 工作流：

1. 推送 `v*.*.*` 版本 Tag 时使用 macOS / Xcode 构建 Release 设备版（arm64）。
2. 校验版本、架构、资源及 IPA 的 `Payload/App.app` 结构，并生成 SHA256。
3. 保存 Actions 的 `forwardx-ios-ipa` 附件；面板 Release 创建后再上传 IPA 与校验文件。iOS 构建失败不会阻塞面板或 Android 发布。

也可在 Actions → iOS IPA → Run workflow 手动构建选定分支；手动构建仅提供 Actions 附件，不修改 GitHub Release。Actions 附件默认保留 30 天，Release 附件不受此期限影响。无需 Apple 账号、签名证书或仓库签名 Secrets。

Android 和 iOS 应用版本分别读取 `shared/versions.ts` 的 `ANDROID_APP_VERSION` / `IOS_APP_VERSION`，发布时保持一致，独立于面板版本。共用 UI 更新时两者一起递增；版本校验会阻止不一致发布。应用根据本平台安装包的版本检查更新，需等相应 APK / IPA 附件构建并上传后才能检测到；仅更新服务端不会替换已安装客户端的内置页面。

## 本地开发与打包

在 macOS 安装 Xcode 26、其 iOS SDK、Node.js 22+ 和 pnpm 10.28.1 后执行：

```bash
pnpm install --frozen-lockfile
pnpm mobile:sync:ios
pnpm mobile:open:ios
```

生成未签名 IPA：

```bash
pnpm mobile:ipa
```

输出位于 `dist/ios/`，此命令会自动构建前端、同步插件、生成项目图标并编译设备版应用。调试真机或模拟器可在 Xcode 中打开 `ios/App/App.xcodeproj`，按需设置自己的签名团队。

Windows / Linux 可以开发共用前端，但不能本地运行 Xcode 编译 IPA，请使用 GitHub 工作流；无需为此安装 CocoaPods，当前 iOS 工程使用 Swift Package Manager。
