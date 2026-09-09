# syntax=docker/dockerfile:1
#
# SillyTavern + wrapper + cloudflared, built for ModelScope Docker Studios.
#
# Constraints this image is shaped by:
#   * ModelScope Studios expose exactly ONE port: 7860. The wrapper owns it.
#   * /mnt/workspace is the only persistent directory, and it is NOT mounted
#     during build - so defaults are baked into /opt/st-seed and copied across
#     on first boot by the wrapper.
#   * Free Studio tier is 2 vCPU / 16 GB, CPU only.
#
# Build:  docker build -t ghcr.io/<you>/st-modelscope:latest ./image
# Push:   docker push ghcr.io/<you>/st-modelscope:latest

# ---------------------------------------------------------------------------
# Stage 1 - bundle the wrapper into a single minified file.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS wrapper-build
WORKDIR /build
COPY wrapper/package.json ./
RUN npm install --no-audit --no-fund
COPY wrapper/src ./src
RUN npx esbuild src/index.js \
      --bundle --platform=node --target=node20 \
      --minify --legal-comments=none \
      --outfile=/build/wrapper.js

# ---------------------------------------------------------------------------
# Stage 2 - fetch SillyTavern at a pinned ref.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS st-build
ARG ST_REF=release
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch "${ST_REF}" https://github.com/SillyTavern/SillyTavern.git app
WORKDIR /src/app
RUN npm install --omit=dev --no-audit --no-fund \
    && rm -rf .git

# ---------------------------------------------------------------------------
# Stage 3 - runtime.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

ARG CLOUDFLARED_VERSION=latest
ARG TARGETARCH=amd64

# tar for backups, curl+ca-certificates for cloudflared and outbound API calls.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tar tini \
    && rm -rf /var/lib/apt/lists/*

# cloudflared, for the trycloudflare quick tunnel.
RUN set -eux; \
    if [ "${CLOUDFLARED_VERSION}" = "latest" ]; then \
      URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH}"; \
    else \
      URL="https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}"; \
    fi; \
    curl -fsSL -o /usr/local/bin/cloudflared "$URL"; \
    chmod +x /usr/local/bin/cloudflared; \
    cloudflared --version

# SillyTavern itself.
COPY --from=st-build /src/app /home/node/app

# Defaults that first boot copies onto the persistent volume.
RUN mkdir -p /opt/st-seed/config /opt/st-seed/data
COPY rootfs/defaults/config.yaml /opt/st-seed/config/config.yaml

# The wrapper.
COPY --from=wrapper-build /build/wrapper.js /opt/wrapper/wrapper.js

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    PUBLIC_PORT=7860 \
    ST_PORT=8000 \
    ST_APP_DIR=/home/node/app \
    SEED_DIR=/opt/st-seed \
    PERSIST_ROOT=/mnt/workspace/sillytavern \
    TUNNEL_ENABLED=true

# ModelScope only routes 7860.
EXPOSE 7860

# tini reaps the SillyTavern and cloudflared children.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
