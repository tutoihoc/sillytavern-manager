# SillyTavern Manager in Docker, for a VPS or a home server.
#
#   docker build -t sillytavern-manager -f deploy/docker/Dockerfile .
#   docker run -d --name stm -p 7860:7860 -v stm-data:/data sillytavern-manager
#
# Everything - SillyTavern itself, user data, backups - lives under /data, so
# the named volume is the only thing you need to keep. The manager downloads
# SillyTavern at the version you choose in the panel on first run.
#
# First run: open http://localhost:7860/manager ON THE HOST to set a password.
# Until one is set, the panel refuses connections from anywhere else.

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
    STM_HOME=/data

VOLUME ["/data"]
EXPOSE 7860

# tini reaps the SillyTavern and cloudflared children.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "bin/stm.js", "start"]
