# DDNS 和故障转移

DDNS 用来把域名自动解析到可用入口。ForwardX 可以在主机 IP 变化、入口组成员变化或转发组故障切换时，自动更新 DNS 记录。

常见用途：

- 主机公网 IP 变化后，自动更新主机 DDNS 域名。
- 入口组把多个入口同步到同一个域名。
- 转发组故障时，把域名切换到健康入口。
- CNAME 方式把入口域名指向成员主机自己的 DDNS 域名。

## 快速配置 {#quick-setup}

配置路径：

```text
系统设置 -> 系统配置 -> DDNS 服务商
```

基本流程：

1. 在 DNS 服务商处准备好域名和 API 密钥。
2. 在 ForwardX 的 DDNS 服务商中选择对应服务商。
3. 填写服务商要求的密钥、主域名、Zone ID 或线路等信息。
4. 设置 TTL，建议先使用默认值 `600`。
5. 保存 DDNS 配置。
6. 到主机管理、入口组或转发组中填写要自动维护的域名。

::: warning 权限建议
DDNS 密钥只建议授予目标域名所需权限，不要使用拥有账号全部权限的长期密钥。
:::

## 厂商教程入口

| 服务商 | 官方教程和入口 |
| --- | --- |
| Cloudflare | [创建 API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) / [DNS Records API](https://developers.cloudflare.com/api/resources/dns/subresources/records/) / [API Token 控制台](https://dash.cloudflare.com/profile/api-tokens) |
| 华为云 DNS | [云解析 DNS 文档](https://support.huaweicloud.com/dns/index.html) / [访问密钥 AK/SK](https://support.huaweicloud.com/usermanual-ca/ca_01_0003.html) / [DNS 控制台](https://console.huaweicloud.com/dns/) |
| 阿里云 DNS | [创建 AccessKey](https://help.aliyun.com/zh/ram/user-guide/create-an-accesskey-pair) / [云解析 OpenAPI](https://api.aliyun.com/product/Alidns) / [云解析控制台](https://dns.console.aliyun.com/) |
| 腾讯云 DNSPod | [DNSPod API 简介](https://cloud.tencent.com/document/product/1427/56193) / [API 密钥管理](https://cloud.tencent.com/document/product/598/40488) / [DNSPod 控制台](https://console.cloud.tencent.com/dnspod) |

## Cloudflare {#cloudflare}

适合域名托管在 Cloudflare 的用户。

官方入口：

- [Cloudflare 创建 API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Cloudflare DNS Records API](https://developers.cloudflare.com/api/resources/dns/subresources/records/)
- [Cloudflare API Token 控制台](https://dash.cloudflare.com/profile/api-tokens)

需要准备：

- Cloudflare API Token。
- 可选：Zone ID。

Token 权限建议：

| 权限 | 用途 |
| --- | --- |
| Zone:Read | 未填写 Zone ID 时，用于自动查找域名所在 Zone |
| DNS:Edit | 创建或更新 DNS 记录 |

面板填写：

| 字段 | 说明 |
| --- | --- |
| Zone ID | 可留空，留空时系统会按域名自动识别 |
| API Token | 填写 Cloudflare API Token |

如果你手动填写了 Zone ID，Token 仍然需要能编辑该 Zone 的 DNS 记录。

## 华为云 DNS {#huaweicloud}

适合域名解析托管在华为云云解析 DNS 的用户。

官方入口：

- [华为云云解析 DNS 文档](https://support.huaweicloud.com/dns/index.html)
- [华为云访问密钥 AK/SK 文档](https://support.huaweicloud.com/usermanual-ca/ca_01_0003.html)
- [华为云 DNS 控制台](https://console.huaweicloud.com/dns/)

需要准备：

- Access Key ID。
- Secret Access Key。
- 公网域名 Zone ID。
- 区域，例如 `cn-north-4`。

面板填写：

| 字段 | 说明 |
| --- | --- |
| Access Key ID | 华为云 AK |
| Secret Access Key | 华为云 SK，留空保存时会保留旧密钥 |
| 公网 Zone ID | 云解析 DNS 中对应公网域名的 Zone ID |
| 区域 | 默认可使用 `cn-north-4` |
| 默认线路 | 默认 `default_view` |
| Endpoint | 一般留空即可，特殊环境再填写完整 URL |

如果更新失败，优先确认 AK/SK 是否有云解析 DNS 的记录查询和编辑权限。

## 阿里云 DNS {#aliyun}

适合域名解析托管在阿里云云解析 DNS 的用户。

官方入口：

- [阿里云创建 AccessKey](https://help.aliyun.com/zh/ram/user-guide/create-an-accesskey-pair)
- [阿里云云解析 OpenAPI](https://api.aliyun.com/product/Alidns)
- [阿里云云解析控制台](https://dns.console.aliyun.com/)

需要准备：

- AccessKey ID。
- AccessKey Secret。
- 主域名，例如 `example.com`。

面板填写：

| 字段 | 说明 |
| --- | --- |
| AccessKey ID | 阿里云 AccessKey ID |
| AccessKey Secret | 阿里云 AccessKey Secret，留空保存时会保留旧密钥 |
| 主域名 | 根域名，例如 `example.com` |
| Endpoint | 默认 `https://alidns.aliyuncs.com` |
| 默认线路 | 默认 `default` |

例如你要维护 `a.example.com`，主域名填 `example.com`，ForwardX 会自动拆分主机记录 `a`。

## 腾讯云 DNSPod {#tencentcloud}

适合域名解析托管在腾讯云 DNSPod 的用户。

官方入口：

- [腾讯云 DNSPod API 简介](https://cloud.tencent.com/document/product/1427/56193)
- [腾讯云 API 密钥管理](https://cloud.tencent.com/document/product/598/40488)
- [腾讯云 DNSPod 控制台](https://console.cloud.tencent.com/dnspod)

需要准备：

- SecretId。
- SecretKey。
- 主域名，例如 `example.com`。

面板填写：

| 字段 | 说明 |
| --- | --- |
| SecretId | 腾讯云 SecretId |
| SecretKey | 腾讯云 SecretKey，留空保存时会保留旧密钥 |
| 主域名 | 根域名，例如 `example.com` |
| 默认线路名称 | 通常填 `默认` |
| 默认线路 ID | 可留空，特殊线路才需要填写 |

如果记录无法更新，检查域名是否在 DNSPod 下，并确认密钥有 DNSPod 记录管理权限。

## 自定义 Webhook {#webhook}

Webhook 适合你有自己的 DNS 更新接口，或使用暂未内置支持的服务商。

面板填写：

| 字段 | 说明 |
| --- | --- |
| 请求方法 | 支持 `POST`、`PUT`、`GET` |
| Webhook URL | 接收 DDNS 更新的接口地址 |
| 请求头 | 支持 JSON 或每行一个 Header |

Webhook URL 可以使用变量：

| 变量 | 含义 |
| --- | --- |
| `{{domain}}` | 要更新的完整域名 |
| `{{type}}` | 记录类型，例如 `A`、`AAAA`、`CNAME` |
| `{{value}}` | 要写入的记录值 |
| `{{ttl}}` | TTL |

示例：

```text
https://ddns.example.com/update?domain={{domain}}&type={{type}}&value={{value}}&ttl={{ttl}}
```

请求头 JSON 示例：

```json
{"Authorization":"Bearer your-token"}
```

## 主机 DDNS

配置路径：

```text
主机管理 -> 新增/编辑主机 -> DDNS 服务
```

开启后，Agent 上报的公网 IP 变化时，ForwardX 会自动更新该主机的 DDNS 域名。

记录类型建议：

| 场景 | 建议 |
| --- | --- |
| 只需要 IPv4 入口 | 选择 IPv4，会生成 A 记录 |
| 只需要 IPv6 入口 | 选择 IPv6，会生成 AAAA 记录 |

如果服务商配置未启用，主机 DDNS 开关会不可用，需要先回到系统设置配置 DDNS 服务商。

## 入口组和转发组

入口组适合多个入口机器共用一个域名。

配置路径：

```text
链路管理 -> 转发组 -> 入口组
```

记录类型要求：

| 类型 | 要求 |
| --- | --- |
| A | 成员机器需要有 IPv4 |
| AAAA | 成员机器需要有 IPv6 |
| CNAME | 成员机器需要配置 DDNS 域名 |

如果选择 CNAME，ForwardX 会把入口域名指向成员机器配置好的 DDNS 域名。这样成员 IP 变化时，通常只需要更新成员自己的 DDNS。

## 故障切换建议

- 不要把故障切换时间设置得太短。
- 网络偶发抖动时，太短的时间可能导致频繁切换。
- 重要业务建议开启链路测试和延迟观察。
- 恢复后是否切回，取决于你是否希望优先使用主入口。
- 建议先用测试域名验证，再切换生产域名。

## 域名来源优先级

ForwardX 展示入口地址时，一般会优先使用用户在主机或组内填写的域名或 IP。

如果没有填写，会尝试使用自动检测到的公网地址或 DDNS 地址。

建议重要业务手动设置清晰的域名，避免用户直接依赖可能变化的 IP。

## 排查 DDNS

如果 DDNS 没有更新：

1. 确认系统设置中 DDNS 已启用，且服务商不是“不使用”。
2. 确认主域名、Zone ID、线路、密钥填写正确。
3. 确认 API 密钥有 DNS 记录查询和编辑权限。
4. 确认主机或入口组填写的域名属于对应主域名。
5. 查看系统日志和入口组事件记录。

常见错误：

| 现象 | 可能原因 |
| --- | --- |
| 提示域名不在主域名下 | 阿里云、腾讯云主域名填写错误 |
| Cloudflare 找不到 Zone | Token 没有 Zone:Read 权限，或 Zone ID 未填写且自动识别失败 |
| 权限不足 | API 密钥权限太小或绑定了错误域名 |
| AAAA 不更新 | 成员机器没有可用 IPv6 |
| CNAME 不更新 | 成员机器没有配置 DDNS 域名 |
