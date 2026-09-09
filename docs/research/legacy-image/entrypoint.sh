#!/bin/sh
set -eu

# Runtime wiring. Everything here has to happen at RUNTIME rather than build
# time, because /mnt/workspace does not exist while `docker build` runs.

PERSIST_ROOT="${PERSIST_ROOT:-/mnt/workspace/sillytavern}"
ST_APP_DIR="${ST_APP_DIR:-/home/node/app}"

echo "[entrypoint] persist root: ${PERSIST_ROOT}"

if [ ! -d /mnt/workspace ]; then
  echo "[entrypoint] WARNING: /mnt/workspace is missing."
  echo "[entrypoint] On ModelScope this should exist and be persistent."
  echo "[entrypoint] Falling back to container-local storage - DATA WILL BE LOST on restart."
fi

# Create the persistent layout up front so the symlinks below always resolve.
for d in data config plugins extensions _wrapper _backups; do
  mkdir -p "${PERSIST_ROOT}/${d}"
done

# SillyTavern resolves config/ and plugins/ relative to its app directory, so
# point those at the persistent volume. (data/ is handled by SILLYTAVERN_DATAROOT.)
link_dir() {
  target="$1"; link="$2"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    # Preserve anything the image shipped, once.
    cp -rn "$link"/. "$target"/ 2>/dev/null || true
    rm -rf "$link"
  fi
  ln -sfn "$target" "$link"
}

link_dir "${PERSIST_ROOT}/config"  "${ST_APP_DIR}/config"
link_dir "${PERSIST_ROOT}/plugins" "${ST_APP_DIR}/plugins"
mkdir -p "${ST_APP_DIR}/public/scripts/extensions"
link_dir "${PERSIST_ROOT}/extensions" "${ST_APP_DIR}/public/scripts/extensions/third-party"

echo "[entrypoint] starting wrapper on port ${PUBLIC_PORT:-7860}"
exec node /opt/wrapper/wrapper.js
