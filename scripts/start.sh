#!/bin/sh
set -e

export HOME=/home/nextjs
export DOCKER_CONFIG=/home/nextjs/.docker
mkdir -p "$DOCKER_CONFIG"
chown -R nextjs:nodejs /home/nextjs

# Match the container user's supplementary group to the host docker socket GID.
if [ -S /var/run/docker.sock ]; then
  SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
  SOCK_GROUP=$(getent group "$SOCK_GID" | cut -d: -f1)
  if [ -z "$SOCK_GROUP" ]; then
    SOCK_GROUP="dockersock"
    addgroup -g "$SOCK_GID" -S "$SOCK_GROUP" 2>/dev/null || SOCK_GROUP=$(getent group "$SOCK_GID" | cut -d: -f1)
  fi
  if [ -n "$SOCK_GROUP" ]; then
    adduser nextjs "$SOCK_GROUP" 2>/dev/null || true
    echo "[dockgen] granted nextjs access to docker socket via group ${SOCK_GROUP} (gid ${SOCK_GID})"
  fi
else
  echo "[dockgen] warning: /var/run/docker.sock not mounted — Test Build will not work"
fi

BUILD_PORT="${BUILD_SERVICE_PORT:-5173}"
APP_PORT="${NEXT_INTERNAL_PORT:-5174}"
PUBLIC_PORT="${PORT:-5172}"

run_as_nextjs() {
  su-exec nextjs env HOME="$HOME" DOCKER_CONFIG="$DOCKER_CONFIG" "$@"
}

echo "[dockgen] starting docker-build service on port ${BUILD_PORT}..."
run_as_nextjs sh -c "cd /mini-services/docker-build-service && BUILD_SERVICE_PORT=${BUILD_PORT} node index.js" &

echo "[dockgen] starting Next.js app on internal port ${APP_PORT}..."
run_as_nextjs sh -c "cd /app && PORT=${APP_PORT} HOSTNAME=127.0.0.1 node server.js" &

echo "[dockgen] starting port-proxy on public port ${PUBLIC_PORT}..."
exec su-exec nextjs env \
  HOME="$HOME" \
  DOCKER_CONFIG="$DOCKER_CONFIG" \
  PORT="${PUBLIC_PORT}" \
  NEXT_INTERNAL_PORT="${APP_PORT}" \
  BUILD_SERVICE_PORT="${BUILD_PORT}" \
  node /mini-services/port-proxy/index.mjs
