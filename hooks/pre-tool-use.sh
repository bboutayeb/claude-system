#!/bin/bash
# PreToolUse hook — records tool start time for duration_ms tracking
# Fire-and-forget: exits 0 to never block Claude Code

SERVER_URL="http://127.0.0.1:18766"

PAYLOAD=$(cat 2>/dev/null || echo "{}")

curl -sf -X POST "${SERVER_URL}/pre-tool" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null 2>&1 || true

echo "{}"
exit 0
