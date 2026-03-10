FROM docker.io/cloudflare/sandbox:0.7.11

# Install rclone (for R2 persistence)
RUN apt-get update && apt-get install -y ca-certificates rclone

# Install ZeroClaw (Rust binary)
# Build cache bust: 2026-03-05-v34-zeroclaw
RUN apt-get install -y git build-essential \
  && git clone --depth=1 https://github.com/zeroclaw-labs/zeroclaw.git /tmp/zeroclaw-src \
  && /tmp/zeroclaw-src/zeroclaw_install.sh --install-rust \
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
