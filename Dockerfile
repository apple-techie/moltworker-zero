FROM docker.io/cloudflare/sandbox:0.7.18

# Install rclone (for R2 persistence) + Node.js for dashboard frontend build
RUN apt-get update && apt-get install -y ca-certificates rclone git build-essential clang mold nodejs npm

# Install ZeroClaw (Rust binary)
# Build cache bust: 2026-03-19-v36-zeroclaw-dashboard
RUN rm -rf /tmp/zeroclaw-src \
  && git clone --depth=1 https://github.com/zeroclaw-labs/zeroclaw.git /tmp/zeroclaw-src \
  && cd /tmp/zeroclaw-src/web && npm install && npm run build && cd /tmp/zeroclaw-src \
  && /tmp/zeroclaw-src/install.sh --install-rust  --force-source-build \
  && rm -rf /tmp/zeroclaw-src \
  && ln -sf /root/.cargo/bin/zeroclaw /usr/local/bin/zeroclaw \
  && zeroclaw --version

# Create ZeroClaw directories
RUN mkdir -p /root/.zeroclaw \
  && mkdir -p /root/clawd \
  && mkdir -p /root/clawd/skills

# Copy startup script
RUN apt-get install -y dos2unix
COPY start-zeroclaw.sh /usr/local/bin/start-zeroclaw.sh
RUN dos2unix /usr/local/bin/start-zeroclaw.sh && chmod +x /usr/local/bin/start-zeroclaw.sh

# Copy custom skills
COPY skills/ /root/clawd/skills/

# Set working directory
WORKDIR /root/clawd

# Expose the gateway port
EXPOSE 18789
