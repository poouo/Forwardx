# ForwardX 支付对接说明

ForwardX 支持套餐购买、余额充值、订单回调和权益自动发放。支付平台确认到账后，面板会校验订单并以幂等方式发放套餐或余额；重复回调不会重复入账。

## 支持的通道

| 通道 | 用户侧方式 | 说明 |
| --- | --- | --- |
| EasyPay | 支付宝、微信 | 兼容易支付协议，支持跳转下单和 API 下单 |
| 支付宝官方 | 支付宝 | 支持扫码预下单、电脑网站和手机网站支付 |
| 微信支付 APIv3 | 微信 | 支持 Native 扫码和 H5 支付 |
| Stripe Checkout | Stripe | 通过 Checkout 页面支付并使用 Webhook 确认 |
| GM Pay / Epusdt | USDT | 通过托管收银台支付，支持面板列出的网络 |

管理员在「支付对接」配置通道，并在基础设置中选择支付宝和微信按钮使用 EasyPay 还是官方通道。普通用户只能看到已启用且配置完整的方式。

## 公开地址

支付回调依赖系统设置中的「面板公开访问地址」，例如：

```text
https://panel.example.com
```

生产环境应使用 HTTPS，并确保反向代理正确传递 `Host`、`X-Forwarded-Proto` 和客户端地址。公开地址错误会导致支付完成后跳回错误页面，或让支付平台无法访问异步通知接口。

## 基础设置

| 配置项 | 说明 |
| --- | --- |
| 启用支付 | 关闭后不能创建新支付订单 |
| 商品名称 | 支付平台展示的商品名称 |
| 最低/最高金额 | 限制单笔订单金额；最高金额为 0 时不限制 |
| 订单过期时间 | 待支付订单的有效期 |
| 最大待支付订单 | 单个用户允许保留的待支付订单数；0 表示不限制 |
| 支付宝按钮来源 | EasyPay 或支付宝官方 |
| 微信按钮来源 | EasyPay 或微信支付 APIv3 |

## EasyPay

配置项：

| 配置项 | 说明 |
| --- | --- |
| 接口地址 | 易支付站点根地址，例如 `https://pay.example.com` |
| 商户 PID | 易支付商户 ID |
| 商户密钥 | 用于 MD5 签名 |
| 下单方式 | 跳转支付或 API 下单 |
| 支付宝/微信通道 CID | 可选，指定网关通道 |

回调地址：

```text
https://你的面板域名/api/payment/webhook/easypay
https://你的面板域名/api/payment/return/easypay
```

面板会校验签名、商户号、订单号、支付金额和订单通道。

## 支付宝官方

配置项：

| 配置项 | 说明 |
| --- | --- |
| AppID | 支付宝开放平台应用 AppID |
| 应用私钥 | RSA2 应用私钥，支持 PEM 或纯密钥内容 |
| 支付宝公钥 | 用于验证异步通知签名 |
| 网关地址 | 默认 `https://openapi.alipay.com/gateway.do` |
| 支付模式 | 扫码预下单、电脑网站支付或手机网站支付 |

回调地址：

```text
https://你的面板域名/api/payment/webhook/alipay
https://你的面板域名/api/payment/return/alipay
```

只有签名有效且交易状态为 `TRADE_SUCCESS` 或 `TRADE_FINISHED` 的通知会进入到账处理。

## 微信支付 APIv3

配置项：

| 配置项 | 说明 |
| --- | --- |
| AppID | 微信支付绑定的 AppID |
| 商户号 MchID | 微信支付商户号 |
| 商户 API 私钥 | 商户 API 证书私钥 |
| APIv3 密钥 | 解密支付通知 |
| 商户证书序列号 | 请求签名使用的证书序列号 |
| 微信支付公钥与公钥 ID | 验证通知签名和来源 |
| 支付模式 | Native 扫码或 H5 |
| H5 应用名称 / URL | H5 支付的场景参数 |

回调地址：

```text
https://你的面板域名/api/payment/webhook/wxpay
https://你的面板域名/api/payment/return/wxpay
```

面板会先校验公钥 ID 和通知签名，再使用 APIv3 密钥解密内容。只有 `TRANSACTION.SUCCESS` 且交易状态为 `SUCCESS` 时才处理到账。

## Stripe Checkout

配置项：

| 配置项 | 说明 |
| --- | --- |
| Secret Key | Stripe 后端密钥，例如 `sk_live_...` |
| Publishable Key | Stripe 前端公钥 |
| Webhook Secret | Webhook 签名密钥，例如 `whsec_...` |
| 币种 | 默认 `cny`，也可使用 Stripe 支持的其他币种 |

回调地址：

```text
https://你的面板域名/api/payment/webhook/stripe
https://你的面板域名/api/payment/return/stripe
```

Webhook 至少订阅：

```text
checkout.session.completed
checkout.session.expired
payment_intent.payment_failed
```

面板会校验 `Stripe-Signature`，并校验订单金额、币种和通道。

## USDT

USDT 通道使用兼容 GM Pay / Epusdt 的托管收银台。配置项：

| 配置项 | 说明 |
| --- | --- |
| 网关地址 | GM Pay / Epusdt 服务地址 |
| 商户 PID | 网关分配的商户 ID |
| 商户密钥 | 下单和回调签名密钥 |
| USDT 网络 | TRON、Ethereum、BSC、Polygon、Solana、Aptos 或 Plasma |

保存前可使用「检测网关」确认网关版本、网络和 USDT 支持状态。

回调地址：

```text
https://你的面板域名/api/payment/webhook/gmpay
https://你的面板域名/api/payment/return/gmpay
```

到账处理会校验签名、商户 PID、Token、网络、金额和订单通道。USDT 订单在面板中仍按订单创建时的法币金额记账。

## 订单状态

| 状态 | 说明 |
| --- | --- |
| `pending` | 订单已创建，等待支付 |
| `paid` | 已确认到账，等待或重试权益发放 |
| `processing` | 当前进程已认领订单，正在发放 |
| `completed` | 套餐或余额已经发放完成 |
| `expired` | 订单已过有效期 |
| `cancelled` | 用户取消支付 |
| `failed` | 下单、回调校验或支付处理失败 |

如果发放过程中发生异常，订单会回到 `paid`，后续有效回调可以重试。卡在 `processing` 的订单超过保护时间后也允许重新认领，避免进程中断造成永久挂起。

## 自动发放

支付成功后：

- 套餐订单调用统一订阅发放逻辑，写入订阅并恢复符合条件的用户转发权限。
- 余额订单写入余额流水并恢复符合条件的用户转发权限。
- 折扣码只在套餐发放成功后消耗。
- 已存在相同支付订单号的订阅或余额流水时，直接把订单收敛为 `completed`，不会重复发放。

## 排查顺序

1. 确认面板公开地址和 HTTPS 反向代理配置。
2. 在「支付对接」使用测试下单检查返回链接。
3. 检查支付平台是否成功请求异步通知地址。
4. 在面板日志中核对签名、商户、金额、币种和通道错误。
5. 查看订单状态：`paid` 表示到账但发放未完成，`processing` 表示正在发放，`completed` 表示完成。
6. 不要手工重复修改余额或订阅后再重放生产回调，以免人工操作与自动发放重叠。

## 安全要求

- 不要把商户密钥、私钥、APIv3 密钥或 Webhook Secret 提交到 Git。
- 正式环境使用 HTTPS，并限制管理后台访问。
- 只信任异步通知，不根据浏览器同步返回页面判定到账。
- 修改支付代码后，至少测试下单失败、签名失败、金额不符、重复回调、发放中断和成功发放。
