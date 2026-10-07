# HTTPS 与反向代理

生产环境建议用独立域名和 HTTPS。域名解析到面板入口，反向代理再转发到面板监听端口。

## 登录/注册人机验证

人机验证默认开启，部分浏览器在非 HTTPS 页面中无法完成验证。优先配置可信 HTTPS；如确需兼容 HTTP，管理员可在 **系统设置 → 系统配置 → 登录/注册人机验证** 中关闭并保存，无需重启。此开关同时控制前端组件和后端校验，不影响密码、登录限流、邮箱验证和双重验证。关闭会降低防机器人能力，公网面板建议保持开启；恢复 HTTPS 后可重新开启。

以下示例适用于反向代理与面板位于**同一宿主机**，且宿主机能通过 127.0.0.1:9810 访问面板。反代在容器中时，该地址指反代容器自身，需要改为对应 Docker 服务地址。

## Caddy 自动 HTTPS

将域名解析到服务器，放行 80/443；Caddy 能正常申请证书时可使用：

~~~text
panel.example.com {
    reverse_proxy 127.0.0.1:9810 {
        flush_interval -1
    }
}
~~~

替换域名与端口；证书签发还取决于 DNS、公网可达性和 CA 限制。

## Nginx HTTPS 示例

准备真实证书及私钥，替换域名和证书路径后使用。不要把占位路径直接上线：

~~~nginx
server {
    listen 80;
    server_name panel.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name panel.example.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9810;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
~~~

这是单层边缘反代示例；前面还有 CDN 或其他代理时，应按真实信任链配置来源地址，不能直接信任访客传入的转发头。宝塔站点可以参考同样原则，不要用页面缓存覆盖 API。

## 可信代理

面板默认 FORWARDX_TRUST_PROXY=loopback，只信任回环代理。Docker 端口映射后，面板实际看到的代理来源可能是 Docker 网桥地址，需按真实网络设置可信代理的 IP/子网。

不要为省事配置为信任全部地址。错误的可信代理范围会影响客户端 IP、登录限流、HTTPS Cookie 和语言地区提示。Docker 自定义环境变量还需实际写入 Compose environment，见 [环境变量](./env-vars.md)。

## Agent API、SSE 与缓存

必须完整转发所有路径，尤其是 /api/agent/*、/api/sync、/api/stream：

- 不缓存认证挑战、心跳、报告、登录接口和事件流。
- 不删除请求体、认证头或查询参数，不额外弹出网页人机验证。
- SSE 关闭响应缓冲并允许长连接；CDN 的连接上限仍可能触发重连。
- 不将 API 改写到首页，不用静态 SPA 回退覆盖 API 错误。
- 大型备份导入、证书等请求如被反代拒绝，检查对应上传大小和超时限制，按需调整而不是无限放大。

建议单面板副本；仅配置粘性路由不能解决所有挑战、登录和内存状态的一致性问题。

## 设置公开地址与验证

在「系统设置 → 系统配置」填写 https://panel.example.com，确认 Agent 所在机器也能访问它。公开地址应对应面板根入口，不要加入 /login 等页面路径。

只改此项不会自动修复仍连接旧 URL 的离线 Agent。地址迁移前先阅读 [面板迁移](./migration.md)。

验证登录、Agent 心跳与 SSE、上传和自测；不要只确认首页能打开。Google 登录的回调地址和发起登录域名也须匹配，见 [Google 登录](./google-login.md)。

反代正常后，可限制 9810 的公网访问，只允许反代到达；操作前确认不会阻断仍在使用直连地址的 Agent。
