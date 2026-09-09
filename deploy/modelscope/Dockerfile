# SillyTavern Manager on a free ModelScope Docker Studio.
#
# Upload this file plus README.md to the Studio repository, choose Docker as the
# SDK, and press Launch. Nothing else to configure.
#
# Two ModelScope facts this image is built around:
#   * Studios expose exactly one port, 7860, and the port field is fixed.
#   * /mnt/workspace is the only directory that survives a restart or sleep.
#     STM_HOME points there, so SillyTavern, its data and every backup live on
#     the persistent volume. Note it is still lost if the Studio is renamed,
#     transferred or deleted - turn on R2 backups in the panel for real safety.
#
# The manager installs SillyTavern itself, at runtime, at the version the user
# picks in the panel. That is deliberate: it keeps the image small and lets
# people change SillyTavern version without rebuilding anything.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/stm

# Dependencies first so edits to the source do not re-run npm install.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY bin ./bin
COPY src ./src
COPY LICENSE README.md ./

ENV NODE_ENV=production \
    PORT=7860 \
    STM_HOME=/mnt/workspace/sillytavern-manager

EXPOSE 7860

# tini reaps the SillyTavern and cloudflared children.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "bin/stm.js", "start"]
