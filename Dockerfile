# ---------- 1. Build stage: install dependencies and build frontend/backend ----------
FROM node:22-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@10

RUN apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --prod=false

COPY . .
RUN pnpm build

# ---------- 2. Production dependencies ----------
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN npm install -g pnpm@10
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --prod

# ---------- 3. Runtime image ----------
FROM node:22-alpine AS runner
WORKDIR /app
ARG FORWARDX_VERSION=unknown
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_CONFIG_PATH=/data/database.json \
    SQLITE_PATH=/data/forwardx.db \
    MYSQL_CONFIG_PATH=/data/mysql.json \
    FORWARDX_IMAGE_VERSION=$FORWARDX_VERSION
LABEL org.opencontainers.image.version=$FORWARDX_VERSION \
      org.forwardx.version=$FORWARDX_VERSION

RUN apk add --no-cache tini git curl openssl docker-cli docker-cli-compose && mkdir -p /data
VOLUME ["/data"]

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/package.json ./

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
