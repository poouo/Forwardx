# ForwardX 中国区域白名单

这个插件把中国区域白名单脚本适配到 ForwardX 面板里使用。安装后在「插件使用」中选择要同步插件程序和数据的 Agent 主机，保存后即可在当前插件下方的「Agent 节点管理」中新增、查看、修改或删除该 Agent 的实际白名单配置。

插件程序和预制数据会随 Agent 心跳同步。每台主机的配置彼此独立；资源同步只会在配置不存在时写入默认配置，不会周期性覆盖用户在节点管理中保存的内容。

Agent 节点管理通过通用 `resourceSchema` 和 Agent 操作接口实现，需要 Agent `2.2.149` 或更高版本，不会占用转发规则队列。选择 Agent 后会自动读取已配置的全国或省份名单、防火墙后端、规则数量、持久化服务状态和执行错误；保存或删除后会自动回读最新状态。

## 支持能力

- 全国 CN 或省级 CIDR 白名单；选择省份时会自动排除全国 CIDR，避免范围被扩大。
- 额外 ASN 白名单，例如 `AS16509`。
- 端口优先白名单，例如 `22=上海市,AS16509,1.2.3.4/32;10000-20000=广东省,江苏省`。
- nftables 优先，也可手动指定 iptables/ipset。
- 可托管本机 INPUT 和 DNAT/FORWARD 入站流量，也可以只限制本机入站或指定接口。
- 支持查看状态、预演规则、应用规则、清理规则和更新 ASN。

## 下发位置

Agent 会把完整插件目录写入：

```text
/var/lib/forwardx-agent/plugins/china-region-whitelist
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

插件适配层为 `forwardx-agent-run.sh`，用于让 ForwardX Agent 以非交互方式执行状态查看、JSON 状态回传、预演、应用和清理。
