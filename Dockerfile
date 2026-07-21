# ---------- 1. Build stage: install dependencies and build frontend/backend ----------
FROM node:22-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@10

RUN apk add --no-cache bash python3 make g++ curl ca-certificates

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --prod=false

COPY . .
RUN pnpm build

# ---------- 1b. Agent/runtime assets ----------
FROM --platform=$BUILDPLATFORM golang:1.23-bookworm AS agent-assets
WORKDIR /app
ARG ZIG_VERSION=0.13.0
ARG CARGO_ZIGBUILD_VERSION=0.23.0
ARG BUILDARCH
ARG FXP_IMPLEMENTATION=rust
ENV PATH="/root/.cargo/bin:/opt/zig:${PATH}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git g++ g++-aarch64-linux-gnu xz-utils \
  && rm -rf /var/lib/apt/lists/*
RUN if [ "$FXP_IMPLEMENTATION" = "rust" ]; then \
    curl -fsSL --retry 3 https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl; \
  fi
RUN if [ "$FXP_IMPLEMENTATION" = "rust" ]; then \
    case "$BUILDARCH" in amd64) ZIG_ARCH=x86_64 ;; arm64) ZIG_ARCH=aarch64 ;; *) echo "Unsupported build architecture: $BUILDARCH" >&2; exit 1 ;; esac \
    && curl -fsSL --retry 3 -o /tmp/zig.tar.xz "https://ziglang.org/download/${ZIG_VERSION}/zig-linux-${ZIG_ARCH}-${ZIG_VERSION}.tar.xz" \
    && tar -xJf /tmp/zig.tar.xz -C /opt \
    && mv "/opt/zig-linux-${ZIG_ARCH}-${ZIG_VERSION}" /opt/zig \
    && rm -f /tmp/zig.tar.xz \
    && cargo install cargo-zigbuild --version "$CARGO_ZIGBUILD_VERSION" --locked; \
  fi
COPY . .
RUN FXP_IMPLEMENTATION="$FXP_IMPLEMENTATION" bash scripts/build-agent-release.sh

# ---------- 2. Production dependencies ----------
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN npm install -g pnpm@10
RUN apk add --no-cache python3 make g++ git
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --prod

# ---------- 3. Runtime image ----------
FROM node:22-alpine AS runner
WORKDIR /app
ARG FORWARDX_VERSION=unknown
ENV NODE_ENV=production \
    PORT=3000 \
    FORWARDX_PORT_MANAGEMENT=docker \
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
COPY --from=agent-assets /app/dist/agent ./dist/agent
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/package.json ./

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
