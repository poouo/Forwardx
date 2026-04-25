# PortFlow 修复 TODO

- [x] Bug1-1 copyToClipboard fallback 增加结果检测
- [x] Bug1-2 「完整脚本」区域改为展示/复制真实脚本（script 字段）
- [x] Bug2-1 前端表单：connectionType=agent 时端口禁用并强制 22
- [x] Bug2-2 后端 hosts.create/update 对非 SSH 主机强制端口为 22
- [x] Bug3-1 后端 updateForwardRule：关键字段变更时重置 isRunning=false
- [x] Bug3-2 toggle 启用时同步重置 isRunning，触发心跳重新下发
- [x] Bug4-1 心跳返回的 realm 改为写入 systemd unit 并 systemctl 启动
- [x] Bug4-2 修正 UDP 参数为 --udp（而非 --protocol udp）
- [x] Bug5-1 agent 脚本仅在命令成功 + 端口监听 OK 时上报 isRunning=true
- [x] Bug5-2 失败时不进行 isRunning=true 上报，remove 完成统一上报 false
- [x] Bug6-1 后端 getInstallScript 返回真正脚本，字段改名 script
- [x] Bug6-2 前端 Settings 改用 script 字段
- [x] Feat-1 Agent 心跳采集 PORTFLOW_<port> 计数链流量并上报
- [x] Feat-2 后端新增 rules.trafficSummary / trafficSeries 聚合接口
- [x] Feat-3 前端 Rules 页面新增汇总卡、列内流量、流量趋势弹窗

## Round 2

- [x] R2-Bug Agent 执行后被控端口未监听 - 链路排查
- [x] R2-Bug 心跳下发 commands 中含 heredoc 多行字符串导致 jq 拆分错乱
- [x] R2-Bug agent.sh 中 while read 拆 commands 时丢失多行 systemd unit
- [x] R2-Bug realm 二进制可能未安装/路径不为 /usr/local/bin/realm
- [x] R2-Bug iptables forward/sysctl ip_forward 未启用
- [x] R2-Feat 后端新增 system.exportConfig / system.importConfig
- [x] R2-Feat 前端 Settings 增加导出下载与导入上传 UI
- [x] R2-Verify 重新 tsc + build 通过并打包

## Round 3 - 转发自测

- [x] R3-DB 新增 forward_tests 表存储自测请求/结果
- [x] R3-API rules.startSelfTest 创建一条自测任务，写入 pending
- [x] R3-API agent 心跳返回 selftest 任务列表（按 hostId）
- [x] R3-Agent 实测 TCP/UDP 端口监听 + nc 探测目标 IP:端口
- [x] R3-Agent 上报结果到 /api/agent/selftest-result
- [x] R3-API rules.getSelfTest 拉取最新结果（轮询）
- [x] R3-UI Rules 页面操作列新增"自测"按钮 + 弹窗显示进度与结果

## Round 4

- [ ] R4-Bug hosts.update port 可选化（agent 主机不传 port 不再触发 Zod min 1）
- [ ] R4-Bug 后端 hosts.create/update 在非 SSH 时 port 强制为 22 并接受 null
- [ ] R4-Bug Token 弹窗复制失效：统一 copyToClipboard，textarea fallback 检测
- [ ] R4-Opt 自测「本机 127.0.0.1 贯穿」改为可选参考，不参与最终成功判定
- [ ] R4-UI 自测弹窗中标注"可选 / 仅供参考"避免误报
- [ ] R4-Doc 明确跨版本迁移仅靠导出/导入；面板提示与 README 同步
- [ ] R4-Verify tsc + build 通过 + 打包 v4

- [ ] R4-Perf 自测延迟太长：心跳间隔默认 30s 导致体感卡死；缩短自测专用心跳到 3s（agent 检测到 selftests 后立即下一轮）
- [ ] R4-Perf agent 探测超时降到 1s + nc -n 跳过 DNS
- [ ] R4-Perf 后端引入"待办自测计数器"，前端 startSelfTest 后立即提示"正在通知 Agent"

## Round 5 - 单容器 + 内置 SQLite

- [ ] R5-Db 引入 better-sqlite3 与 drizzle-orm/better-sqlite3
- [ ] R5-Db schema.ts 改用 sqliteTable，字段类型迁移（int / text / integer ts）
- [ ] R5-Db db.ts 全面适配（同步驱动 / 查询语法 / 默认值 / onUpdate 由代码维护）
- [ ] R5-Db 流量统计、时间分桶 SQL 改为 SQLite 语法（unixepoch / strftime）
- [ ] R5-Docker Dockerfile 安装 sqlite + 编译 better-sqlite3 native
- [ ] R5-Docker docker-compose.yml 改为单服务 + /data 卷挂载
- [ ] R5-Env 移除 DATABASE_URL 依赖，改为 SQLITE_PATH（默认 /data/portflow.db）
- [ ] R5-Verify tsc + build + 容器启动初始化数据库
