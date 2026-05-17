# ForwardX 支付对接说明

ForwardX 面板内置支付对接能力，管理员可以在后台集中配置支付通道，用户创建支付订单后由支付平台回调确认结果。当前版本会记录订单支付状态，套餐、余额、流量或到期时间的自动权益发放可在后续版本继续接入。

## 支持的支付方式

| 通道 | 面向用户的按钮 | 说明 |
| --- | --- | --- |
| EasyPay | 支付宝、微信 | 兼容常见易支付协议的聚合支付，支持跳转支付和 API 下单 |
| 支付宝官方 | 支付宝 | 直接对接支付宝开放平台，支持扫码预下单、电脑网站支付和手机网站支付 |
| 微信官方 | 微信 | 直接对接微信支付 APIv3，支持 Native 扫码和 H5 支付 |
| Stripe | Stripe | 使用 Stripe Checkout 创建支付页面，通过 Webhook 确认支付结果 |

用户侧只需要选择“支付宝”“微信”或“Stripe”。管理员可以在“基础设置”中决定支付宝按钮走 EasyPay 还是支付宝官方，微信按钮走 EasyPay 还是微信官方。

## 后台入口

管理员登录后进入左侧导航栏的“支付对接”。普通用户不可见。

首次配置前建议先在系统设置中填写“面板公开访问地址”，例如：

```text
https://panel.example.com
```

支付平台回调必须能从公网访问这个地址。生产环境建议使用 HTTPS，Stripe 在正式环境下要求 Webhook 使用 HTTPS。

## 基础设置

| 配置项 | 说明 |
| --- | --- |
| 启用支付功能 | 关闭后用户无法创建支付订单 |
| 商品名称 | 生成订单时展示给支付平台和用户的商品名称 |
| 最低金额 | 单笔订单最低支付金额 |
| 最高金额 | 单笔订单最高支付金额，填 0 表示不限制 |
| 订单过期时间 | 待支付订单的有效时间 |
| 最大待支付订单 | 同一用户最多允许同时存在的待支付订单，填 0 表示不限制 |
| 支付宝按钮来源 | 可选择 EasyPay 或支付宝官方 |
| 微信按钮来源 | 可选择 EasyPay 或微信官方 |

## EasyPay

需要填写：

| 配置项 | 说明 |
| --- | --- |
| 接口地址 | 易支付站点地址，例如 `https://pay.example.com` |
| 商户 PID | 易支付商户 ID |
| 商户密钥 | 易支付商户密钥 |
| 下单方式 | 跳转支付或 API 下单 |
| 支付宝通道 CID | 可选，用于指定支付宝通道 |
| 微信通道 CID | 可选，用于指定微信通道 |

回调地址：

```text
https://你的面板域名/api/payment/webhook/easypay
https://你的面板域名/api/payment/return/easypay
```

## 支付宝官方

需要填写：

| 配置项 | 说明 |
| --- | --- |
| AppID | 支付宝开放平台应用 AppID |
| 应用私钥 | RSA2 应用私钥，支持 PEM 或纯密钥内容 |
| 支付宝公钥 | 支付宝开放平台提供的支付宝公钥 |
| 网关地址 | 默认 `https://openapi.alipay.com/gateway.do` |
| 支付模式 | 扫码预下单、电脑网站支付或手机网站支付 |

回调地址：

```text
https://你的面板域名/api/payment/webhook/alipay
https://你的面板域名/api/payment/return/alipay
```

面板会校验支付宝异步通知签名，仅在 `TRADE_SUCCESS` 或 `TRADE_FINISHED` 时标记订单为已支付。

## 微信官方

需要填写：

| 配置项 | 说明 |
| --- | --- |
| AppID | 微信支付绑定的 AppID |
| 商户号 MchID | 微信支付商户号 |
| 商户 API 私钥 | 商户 API 证书私钥，支持 PEM 格式 |
| APIv3 密钥 | 32 位 APIv3 密钥，用于解密支付通知 |
| 商户证书序列号 | 商户 API 证书序列号 |
| 微信支付公钥 | 微信支付公钥，支持 PEM 格式 |
| 微信支付公钥 ID | 微信支付公钥 ID，用于校验通知来源 |
| 支付模式 | Native 扫码或 H5 支付 |
| H5 应用名称 / URL | H5 支付可选参数 |

回调地址：

```text
https://你的面板域名/api/payment/webhook/wxpay
https://你的面板域名/api/payment/return/wxpay
```

面板会校验微信支付通知签名，并使用 APIv3 密钥解密通知内容，仅在交易状态为 `SUCCESS` 时标记订单为已支付。JSAPI 支付需要用户 OpenID 和 OAuth 流程，当前版本暂未开放前台 JSAPI 支付流程。

## Stripe

需要填写：

| 配置项 | 说明 |
| --- | --- |
| Secret Key | Stripe 后端密钥，例如 `sk_live_...` |
| Publishable Key | Stripe 前端公钥，当前主要用于记录和后续扩展 |
| Webhook Secret | Stripe Webhook 签名密钥，例如 `whsec_...` |
| 币种 | 默认 `cny`，也可以填写 Stripe 支持的其他币种 |

回调地址：

```text
https://你的面板域名/api/payment/webhook/stripe
https://你的面板域名/api/payment/return/stripe
```

Stripe Webhook 至少需要订阅：

```text
checkout.session.completed
checkout.session.expired
payment_intent.payment_failed
```

## 订单状态

| 状态 | 说明 |
| --- | --- |
| pending | 已创建，等待用户支付 |
| paid | 支付平台回调确认已支付 |
| completed | 预留状态，可用于后续权益发放完成 |
| expired | 超过订单有效期 |
| cancelled | 预留状态，可用于用户取消订单 |
| failed | 支付失败或回调失败 |

## 安全建议

- 不要把支付密钥、私钥、APIv3 密钥提交到 Git 仓库。
- 正式环境建议使用 HTTPS，并确认反向代理正确传递 `Host` 和 `X-Forwarded-Proto`。
- 支付平台回调失败时优先检查面板公开访问地址、防火墙、证书、平台回调日志和 ForwardX 面板日志。
- 修改支付路由后，建议使用“测试下单”分别验证支付宝、微信和 Stripe 的创建订单及回调流程。
