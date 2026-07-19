#!/bin/sh
set -e
echo "[dockgen] starting docker-build service on port 3003..."
cd /mini-services/docker-build-service
node index.js &
echo "[dockgen] starting Next.js app on port ${PORT:-3000}..."
cd /app
exec node server.js
