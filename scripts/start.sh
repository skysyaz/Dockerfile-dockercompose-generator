#!/bin/sh
set -e
BUILD_PORT="${BUILD_SERVICE_PORT:-5173}"
APP_PORT="${PORT:-5172}"
echo "[dockgen] starting docker-build service on port ${BUILD_PORT}..."
cd /mini-services/docker-build-service
BUILD_SERVICE_PORT="${BUILD_PORT}" node index.js &
echo "[dockgen] starting Next.js app on port ${APP_PORT}..."
cd /app
PORT="${APP_PORT}" exec node server.js
