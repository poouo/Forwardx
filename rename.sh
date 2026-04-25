#!/bin/bash
set -e
cd /home/ubuntu/portflow-latest/portflow

# ========== 1. UI / 文档中的品牌名 ==========
# "PortFlow" -> "ForwardX" (品牌名，大小写敏感)
sed -i 's/PortFlow/ForwardX/g' \
  index.html \
  README.md \
  client/src/components/DashboardLayout.tsx \
  client/src/pages/Login.tsx \
  client/src/pages/Settings.tsx \
  drizzle/schema.ts \
  .env.example

# ========== 2. package.json name ==========
sed -i 's/"name": "portflow"/"name": "forwardx"/g' package.json

# ========== 3. Docker / 部署配置中的 portflow ==========
# docker-compose.yml: 服务名、镜像名、容器名、卷名
sed -i 's/portflow-panel/forwardx-panel/g' docker-compose.yml
sed -i 's/image: portflow:latest/image: forwardx:latest/g' docker-compose.yml
sed -i 's/portflow-data/forwardx-data/g' docker-compose.yml
sed -i 's/  portflow:/  forwardx:/g' docker-compose.yml

# ========== 4. 数据库文件名 portflow.db -> forwardx.db ==========
sed -i 's/portflow\.db/forwardx.db/g' \
  .env.example \
  Dockerfile \
  docker-compose.yml \
  drizzle.config.ts \
  server/env.ts \
  server/db.ts

# ========== 5. 其他代码中的 portflow ==========
# cookie/theme storage key
sed -i 's/portflow-theme/forwardx-theme/g' client/src/contexts/ThemeContext.tsx
# default secret
sed -i 's/portflow-default-secret-change-me/forwardx-default-secret-change-me/g' server/env.ts
# db.ts email
sed -i 's/admin@portflow\.local/admin@forwardx.local/g' server/db.ts
# Settings 导出文件名
sed -i 's/portflow-config-/forwardx-config-/g' client/src/pages/Settings.tsx

# ========== 6. agentRoutes.ts 中的品牌名和服务名 ==========
# Agent 脚本中的注释和提示文字: "PortFlow Agent" -> "ForwardX Agent"
sed -i 's/PortFlow Agent/ForwardX Agent/g' server/agentRoutes.ts
# Agent 脚本中的 systemd 服务名: portflow-agent -> forwardx-agent
sed -i 's/portflow-agent/forwardx-agent/g' server/agentRoutes.ts
# Agent 脚本中的 realm/socat 服务名: portflow-realm- -> forwardx-realm-
sed -i 's/portflow-realm-/forwardx-realm-/g' server/agentRoutes.ts
# portflow-socat- -> forwardx-socat-
sed -i 's/portflow-socat-/forwardx-socat-/g' server/agentRoutes.ts
# Agent 安装目录: /opt/portflow-agent -> /opt/forwardx-agent
sed -i 's|/opt/portflow-agent|/opt/forwardx-agent|g' server/agentRoutes.ts
# Agent 状态目录: /var/lib/portflow-agent -> /var/lib/forwardx-agent
sed -i 's|/var/lib/portflow-agent|/var/lib/forwardx-agent|g' server/agentRoutes.ts

# 注意：PORTFLOW_IN_xxx / PORTFLOW_OUT_xxx / PORTFLOW_xxx 是 iptables 链名，
# 这些是运行时标识符，改名需要保持一致性。改为 FWX_ 前缀更简洁。
sed -i 's/PORTFLOW_IN_/FWX_IN_/g' server/agentRoutes.ts
sed -i 's/PORTFLOW_OUT_/FWX_OUT_/g' server/agentRoutes.ts
# 旧版兼容链名 PORTFLOW_xxx (不带 IN/OUT)
sed -i 's/PORTFLOW_/FWX_/g' server/agentRoutes.ts

# README.md 中的 portflow 目录名
sed -i 's|portflow/|forwardx/|g' README.md
# README 中的 git clone 目标目录
sed -i 's/git clone <your-repo-url> portflow/git clone <your-repo-url> forwardx/g' README.md
sed -i 's/cd portflow/cd forwardx/g' README.md
# README 中残留的 portflow 引用
sed -i 's/portflow/forwardx/g' README.md

echo "Done! All renames completed."
