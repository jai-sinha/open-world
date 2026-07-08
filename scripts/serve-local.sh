#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Starting local dataset server..."
bun run planet/serve_local.ts &
LOCAL_PID=$!

echo "Starting frontend with TILES_BASE_URL=http://localhost:3456..."
TILES_BASE_URL="http://localhost:3456" PORT=3000 bun run dev

kill $LOCAL_PID 2>/dev/null
