# ForwardX 中国区域白名单

这个插件把中国区域白名单脚本适配到 ForwardX 面板里使用。安装插件后，可以在「插件使用」中选择要生效的 Agent 主机、白名单范围和执行方式。

默认执行方式是「仅同步配置」，只会把脚本、预制数据和配置写入主机，不会修改防火墙。确认配置无误后，可以切换为「预演规则」查看将要执行的命令，再切换为「应用规则」正式生效。

## 支持能力

- 全国 CN 或省级 CIDR 白名单。
- 额外 ASN 白名单，例如 `AS16509`。
- 端口优先白名单，例如 `22=上海市,AS16509,1.2.3.4/32;10000-20000=广东省,江苏省`。
- nftables 优先，也可手动指定 iptables/ipset。
- 可托管本机 INPUT 和 DNAT/FORWARD 入站流量，也可以只限制本机入站或指定接口。
- 支持查看状态、预演规则、应用规则、清理规则和更新 ASN。

## 下发位置

Agent 会把完整插件目录写入：

```text
/etc/forwardx/plugins/china-region-whitelist
```

面板生成的脚本配置会写入：

```text
/etc/china-region-whitelist.conf
```

正式应用后，插件会尽量配置开机恢复。没有 systemd 的系统会应用当前规则，但可能无法使用原脚本的 systemd 开机恢复能力。

## 数据说明

插件内置数据参考 `GHUNLIL/china-region-whitelist` 的预制数据结构：

- `data/country/CN.txt`：国家级中国大陆 IPv4 CIDR。
- `data/regions/*.txt`：省级 CIDR。
- `data/regions.tsv`、`data/regions.json`：区域索引。
- `data/asn/*.txt`：预制 ASN 前缀。
- `tools/firewall_lib.sh`：nftables/iptables 规则生成和清理逻辑。

插件适配层为 `forwardx-agent-run.sh`，用于让 ForwardX Agent 以非交互方式执行状态查看、预演、应用和清理。
