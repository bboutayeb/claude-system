#!/bin/bash
# UserPromptSubmit hook — detects ambiguous user prompts before Claude processes them
# Relays server response: may contain {"decision":"block","reason":"..."} or {}
# Falls back to {} (continue) if server is unreachable — never breaks Claude Code

SERVER_URL="http://127.0.0.1:18766"

PAYLOAD=$(cat 2>/dev/null || echo "{}")

RESULT=$(curl -sf -m 3 -X POST "${SERVER_URL}/user-prompt" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>/dev/null || echo "{}")

echo "$RESULT"
exit 0
