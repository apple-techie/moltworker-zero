# syntax=docker/dockerfile:latest
FROM docker.io/cloudflare/sandbox:0.7.18 AS builder

# 1. System Dependencies (Cached)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update && apt-get install -y \
  ca-certificates git make clang mold nodejs npm curl

WORKDIR /tmp/zeroclaw-src

# 2. THE CACHE BUSTER
# This file changes every time you run 'npm run build' locally.
# Docker will bust the cache here and only here.
COPY .git-hash /tmp/.git-hash

# 3. Clone and Build
RUN git clone --depth=1 https://github.com/zeroclaw-labs/zeroclaw.git .

# Build Web (using NPM cache mount)
WORKDIR /tmp/zeroclaw-src/web
RUN --mount=type=cache,target=/root/.npm \
  npm install && npm run build

# Build Rust
WORKDIR /tmp/zeroclaw-src
RUN --mount=type=cache,target=/root/.cargo/registry \
  --mount=type=cache,target=/root/.cargo/git \
  ./install.sh --install-rust --force-source-build

# 4. Consolidate skills AFTER the clone/build
RUN mkdir -p /tmp/skills-out && \
  cp -r /tmp/zeroclaw-src/skills/* /tmp/skills-out/ 2>/dev/null || true

# ── STAGE 2: Runtime ─────────────────────────────────────────
FROM docker.io/cloudflare/sandbox:0.7.18 AS runtime

# override number of instances to save memory
ENV JAVASCRIPT_POOL_MIN_SIZE=0
ENV TYPESCRIPT_POOL_MIN_SIZE=0

# 1. Install ONLY runtime essentials (No compilers, no Node, no NPM)
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates rclone git curl dos2unix bash sqlite sed\
  && rm -rf /var/lib/apt/lists/*

# 2. Copy ONLY the finished binary and skills from the builder
RUN mkdir -p /root/.zeroclaw /root/clawd/skills
COPY --from=builder /root/.cargo/bin/zeroclaw /usr/local/bin/zeroclaw
COPY --from=builder /tmp/skills-out/ /root/clawd/skills/
COPY skills/ /root/clawd/skills/

# 3. Setup directories and startup script
COPY start-zeroclaw.sh /usr/local/bin/start-zeroclaw.sh
RUN dos2unix /usr/local/bin/start-zeroclaw.sh && chmod +x /usr/local/bin/start-zeroclaw.sh

WORKDIR /root/clawd
EXPOSE 18789
