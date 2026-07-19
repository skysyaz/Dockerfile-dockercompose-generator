#!/bin/sh
set -e

PORT="${PORT:-5173}"

exec uvicorn main:app --host 0.0.0.0 --port "$PORT"
