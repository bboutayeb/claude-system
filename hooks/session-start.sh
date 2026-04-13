#!/bin/bash
# SessionStart hook — launches the Bun HTTP server if not already running
# Fire-and-forget: never exits non-zero to avoid blocking Claude Code

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_URL="http://127.0.0.1:18766"

# Start server if not already up
if ! curl -sf "${SERVER_URL}/health" > /dev/null 2>&1; then
  cd "$REPO_DIR"
  nohup mise exec -- bun run hooks-server/server.ts > /tmp/hooks-server.log 2>&1 &
  # Give it a moment to bind the port
  sleep 0.5
fi

# Read stdin once (Claude Code sends hook payload via stdin)
PAYLOAD=$(cat 2>/dev/null || echo "{}")

BODY=$(echo "$PAYLOAD" | mise exec -- jq '{session_id, model, source, agent_type, transcript_path}' 2>/dev/null || echo '{}')

curl -sf -X POST "${SERVER_URL}/session/start" \
  -H "Content-Type: application/json" \
  -d "$BODY" > /dev/null 2>&1 || true

# Confirmation visible — affichée dans la console Claude au démarrage
STATUS=$(curl -sf "${SERVER_URL}/status" 2>/dev/null || echo "{}")
API_KEY_OK=$(echo "$STATUS" | mise exec -- jq -r '.apiKey // false' 2>/dev/null || echo "false")

if [ "$API_KEY_OK" = "true" ]; then
  echo "[hooks] server OK — ANTHROPIC_API_KEY present" >&2
else
  echo "[hooks] server OK — ANTHROPIC_API_KEY MISSING (Haiku disabled)" >&2
fi

# ── Verifier contextuel (par utilisateur, sans crontab système) ──────────────
# Lance agents/verifier.ts au plus une fois toutes les 6h, uniquement quand
# Claude Code est ouvert. Timestamp stocké dans $XDG_CACHE_HOME (non-invasif).
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
LAST_RUN_FILE="$CACHE_DIR/claude-system-verifier-last-run"
NOW=$(date +%s)
LAST=$(cat "$LAST_RUN_FILE" 2>/dev/null || echo 0)

if (( NOW - LAST >= 21600 )); then
  echo "$NOW" > "$LAST_RUN_FILE"
  nohup mise exec -- bun run "$REPO_DIR/agents/verifier.ts" >> /tmp/claude-verifier.log 2>&1 &
  echo "[hooks] verifier lancé (dernier run il y a $(( (NOW - LAST) / 3600 ))h)" >&2
fi

exit 0
