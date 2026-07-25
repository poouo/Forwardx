# 第三方来源与许可证声明

本插件中的防火墙规则渲染、配置持久化、区域索引读取和 Agent 运行入口由
ForwardX 自行维护，作为 ForwardX 项目的一部分按根目录 `LICENSE` 的
GNU Affero General Public License v3.0 发布。本文件只说明插件使用的数据来源。

## 省级区域数据：metowolf/iplist

以下文件包含由 [metowolf/iplist](https://github.com/metowolf/iplist) 发布的
省级 IP 段或其索引数据：

- `data/regions/*.txt`
- `data/regions.tsv`
- `data/regions.json`
- `data/cncity.md`

上游项目页面说明其数据基于 OpenIPDB、IPinfo 和 bgp.tools 等来源，但在本次
发布审核时没有发现明确的 SPDX 许可证标识或仓库内 `LICENSE` 文件。上述文件
应被视为外部数据集，不是 ForwardX 的原创 IP 归属声明；使用者需要同时遵守
上游项目及其底层数据源的适用条款。来源地址：

- <https://github.com/metowolf/iplist>
- <https://github.com/metowolf/iplist/blob/master/docs/cncity.md>

## 国家级数据：APNIC delegated stats

`data/country/CN.txt` 是根据 APNIC delegated stats 中的 CN IPv4 分配记录生成
的聚合 CIDR 数据。原始数据地址：

- <https://ftp.apnic.net/stats/apnic/delegated-apnic-latest>

该文件是注册表分配数据的派生结果，不包含 APNIC 的软件代码。请按 APNIC 对
统计数据和注册表数据的适用政策使用。

## ASN 数据：ipverse/as-ip-blocks

`data/asn/AS16509.txt` 来源于
[ipverse/as-ip-blocks](https://github.com/ipverse/as-ip-blocks) 的
`as/16509/ipv4-aggregated.txt`。该仓库声明数据采用
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
发布，完整许可文本见上游仓库的 `LICENSE` 文件：

- <https://github.com/ipverse/as-ip-blocks/blob/master/LICENSE>

ASN 数据会在 Agent 有权限且需要时缓存到
`/var/lib/china-region-whitelist/asn/`。缓存下载只访问上述 ipverse 数据路径，
不会下载或执行第三方 shell 脚本。

## 历史版本说明

早期版本曾参考并打包
`GHUNLIL/china-region-whitelist` 的脚本和数据结构。该仓库在本次审核时没有
声明许可证。自插件 `0.7.0` 起，ForwardX 不再打包、下载或执行该上游脚本，
运行时改为 ForwardX 自有实现；历史 Git 提交中的文件不代表当前发布物中的
运行时依赖。
