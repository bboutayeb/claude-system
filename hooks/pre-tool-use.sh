#!/bin/bash
# PreToolUse hook — detects ambiguous tool inputs via Claude Haiku
# Fire-and-forget: exits 0 to never block Claude Code

SERVER_URL="http://127.0.0.1:18766"

PAYLOAD=$(cat 2>/dev/null || echo "{}")

RESULT=$(curl -sf -X POST "${SERVER_URL}/pre-tool" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>/dev/null || echo "{}")

SUGGESTION=$(echo "$RESULT" | mise exec -- jq -r '.suggestion // empty' 2>/dev/null || true)

if [ -n "$SUGGESTION" ]; then
  echo "[clarification] $SUGGESTION" >&2
fi

# Output {} so Claude Code parses it as "continue"
echo "{}"
exit 0
