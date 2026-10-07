# Google 账户登录

Google 登录为可选功能，默认关闭；关闭后原有密码登录不受影响。当前用于网页版，移动 App 仍使用原有登录方式。

## 管理员配置

1. 在 [Google Cloud Console](https://console.cloud.google.com/apis/credentials) 创建项目并配置 OAuth 同意界面，仅使用基本身份权限 `openid email profile`。
2. 创建类型为“Web 应用”的 OAuth 客户端，获取 Client ID 和 Client Secret。
3. 打开面板“系统设置 → 系统配置 → Google 账户登录”，填写客户端信息和完整回调地址，例如 `https://panel.example.com/api/auth/google/callback`。
4. 将同一回调地址添加到 Google Cloud 客户端的“已获授权的重定向 URI”，必须完全一致。
5. 启用并保存后，登录/注册页显示“使用 Google 继续”。密钥仅保存在面板服务端；留空保存会保留旧密钥，可单独清除并关闭功能。

正式部署使用 HTTPS；本机开发允许 `http://localhost:5173/api/auth/google/callback` 等本机地址。必须从回调地址对应的同一面板域名发起登录。Docker 无需额外端口，反向代理应将该 `/api/` 路径转发到面板。

用户浏览器和面板服务器都必须能访问 Google。测试状态的 Google 应用通常仅允许添加的测试用户使用；公开使用需按 Google 要求配置应用发布状态和域名等信息。

## 账户规则

- 未绑定过的 Google 身份，仅在面板开放注册且邮箱满足注册白名单时创建普通用户；Google 负责验证邮箱，不要求重复输入邮件验证码，但不会自动开通转发权限。
- 已有同邮箱账户不会自动合并或绑定。用户应先使用原方式登录，在“个人中心 → Google 账户绑定”中主动绑定。
- 关闭注册后，已绑定用户仍可 Google 登录，未绑定用户不能借此创建新账户。
- 被禁用账户不能登录；已有双重验证仍须完成，原多设备会话策略保持不变。
- 新 Google 账户可以在 Google 登录后的五分钟内于个人中心设置密码；设置密码会使旧会话失效。解绑须验证当前密码，避免仅有 Google 登录的账户被解绑后无法进入。
- Google 登录流程十分钟失效，面板重启、配置变更、跨浏览器/域名操作或并行标签页覆盖登录 Cookie 后需重新发起。

## 排障

- `redirect_uri_mismatch`：Google Cloud 登记地址与面板配置不完全相同，检查协议、域名、端口和路径。
- 提示浏览器 Cookie 不匹配：检查是否从另一域名、IP 或浏览器发起，是否禁用 Cookie，以及是否同时打开多个登录标签页。
- Google 验证失败：检查客户端类型、密钥、Google 应用发布/测试用户状态及服务器到 Google 的网络；请求有超时保护，不会无限挂起。
- 面板日志中的 `[GoogleAuth]` 记录成功用户 ID 或固定失败原因，不记录授权码、令牌或密钥。
