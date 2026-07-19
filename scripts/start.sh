#!/bin/sh
set -e

BUILD_PORT="${BUILD_SERVICE_PORT:-5173}"
APP_PORT="${NEXT_INTERNAL_PORT:-5174}"
PUBLIC_PORT="${PORT:-5172}"

echo "[dockgen] starting docker-build service on port ${BUILD_PORT}..."
cd /mini-services/docker-build-service
BUILD_SERVICE_PORT="${BUILD_PORT}" node index.js &

echo "[dockgen] starting Next.js app on internal port ${APP_PORT}..."
cd /app
PORT="${APP_PORT}" HOSTNAME=127.0.0.1 node server.js &

echo "[dockgen] starting port-proxy on public port ${PUBLIC_PORT}..."
PORT="${PUBLIC_PORT}" \
  NEXT_INTERNAL_PORT="${APP_PORT}" \
  BUILD_SERVICE_PORT="${BUILD_PORT}" \
  exec node /mini-services/port-proxy/index.mjs
