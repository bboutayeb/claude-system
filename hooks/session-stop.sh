#!/bin/bash
# Stop hook — records session end and token usage
# Payload from Claude Code contains session_id and usage stats

SERVER_URL="http://127.0.0.1:18766"

PAYLOAD=$(cat)

curl -sf -X POST "${SERVER_URL}/session/stop" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null 2>&1 || true

exit 0
