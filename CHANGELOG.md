# Changelog

本文件记录 ForwardX 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2025-04-25

### 新增

- 多引擎端口转发：支持 iptables、realm、socat 三种转发工具
- 多主机 Agent 管理：一键安装脚本、systemd 服务、心跳上报
- 转发规则管理：创建/编辑/启停/删除，支持 TCP/UDP/Both 协议
- 流量统计：基于 iptables 计数链的精确流量采集，支持趋势图表
- 带宽限速：基于 tc 的每规则独立上传/下载限速
- 连通性检测：目标可达性检测 + ping 延迟测量
- 多用户权限：管理员/普通用户角色分离，资源隔离
- 主机监控：CPU、内存、网络、磁盘使用率实时上报
- 配置导入导出：JSON 格式的规则和主机配置备份与恢复
- Docker 一键部署：多阶段构建，内置 SQLite
- 暗色主题：亮色/暗色主题切换，跟随系统偏好
