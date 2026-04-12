#!/bin/bash
# SessionStart hook — launches the Bun HTTP server if not already running
# Fire-and-forget: never exits non-zero to avoid blocking Claude Code

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_URL="http://127.0.0.1:18766"

# Start server if not already up
if ! curl -sf "${SERVER_URL}/health" > /dev/null 2>&1; then
  cd "$REPO_DIR"
  nohup bun run hooks-server/server.ts > /tmp/hooks-server.log 2>&1 &
  # Give it a moment to bind the port
  sleep 0.5
fi

# Read stdin once (Claude Code sends hook payload via stdin)
PAYLOAD=$(cat 2>/dev/null || echo "{}")
SESSION_ID=$(echo "$PAYLOAD" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")

curl -sf -X POST "${SERVER_URL}/session/start" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\": \"${SESSION_ID}\"}" > /dev/null 2>&1 || true

exit 0
