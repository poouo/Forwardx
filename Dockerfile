# ---------- 1. 构建阶段：完整依赖 + 编译前端/后端 ----------
FROM node:22-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@10
# better-sqlite3 是原生模块，需要在容器内编译
RUN apk add --no-cache python3 make g++ sqlite-dev

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --prod=false

COPY . .
RUN pnpm build

# 仅安装生产依赖到独立目录，避免最终镜像携带构建工具
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN npm install -g pnpm@10
RUN apk add --no-cache python3 make g++ sqlite-dev
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --prod

# ---------- 2. 运行阶段：单镜像，内置 SQLite ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    SQLITE_PATH=/data/forwardx.db

# 运行阶段保留 sqlite 命令行便于排障；tini 接管 PID 1 让信号正常传递
RUN apk add --no-cache sqlite tini && mkdir -p /data
VOLUME ["/data"]

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/package.json ./

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
