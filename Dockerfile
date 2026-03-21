# syntax=docker/dockerfile:1.7

# ── STAGE 1: The Builder ─────────────────────────────────────
FROM docker.io/cloudflare/sandbox:0.7.18 AS builder

# Install build-only dependencies
RUN apt-get update && apt-get install -y \
  ca-certificates rclone git build-essential clang mold nodejs npm curl

# Build ZeroClaw
RUN git clone --depth=1 https://github.com/zeroclaw-labs/zeroclaw.git /tmp/zeroclaw-src \
  && cd /tmp/zeroclaw-src/web && npm install && npm run build \
  && cd /tmp/zeroclaw-src && ./install.sh --install-rust --force-source-build

# ── STAGE 2: The Runtime (What you actually deploy) ──────────
FROM docker.io/cloudflare/sandbox:0.7.18

# 1. Install ONLY runtime essentials (No compilers, no Node, no NPM)
RUN apt-get update && apt-get install -y \
  ca-certificates rclone git curl dos2unix \
  && rm -rf /var/lib/apt/lists/*

# 2. Copy ONLY the finished binary from the builder
COPY --from=builder /root/.cargo/bin/zeroclaw /usr/local/bin/zeroclaw

# 3. Setup directories and startup script
RUN mkdir -p /root/.zeroclaw /root/clawd/skills
COPY start-zeroclaw.sh /usr/local/bin/start-zeroclaw.sh
RUN dos2unix /usr/local/bin/start-zeroclaw.sh && chmod +x /usr/local/bin/start-zeroclaw.sh

# 4. Copy custom skills
COPY skills/ /root/clawd/skills/

WORKDIR /root/clawd
EXPOSE 18789
ENTRYPOINT ["/usr/local/bin/start-zeroclaw.sh"]