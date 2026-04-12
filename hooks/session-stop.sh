#!/bin/bash
# Stop hook — reads token usage from transcript JSONL and persists to DB

SERVER_URL="http://127.0.0.1:18766"

PAYLOAD=$(cat)
SESSION_ID=$(echo "$PAYLOAD" | mise exec -- jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")
TRANSCRIPT=$(echo "$PAYLOAD" | mise exec -- jq -r '.transcript_path // ""' 2>/dev/null || echo "")

# Aggregate token usage from all assistant messages in the transcript
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  USAGE=$(grep -v '^$' "$TRANSCRIPT" \
    | mise exec -- jq -sc '
        [ .[] | select(.type == "assistant" and .message.usage != null) | .message.usage ]
        | {
            input_tokens:              (map(.input_tokens // 0)              | add // 0),
            output_tokens:             (map(.output_tokens // 0)             | add // 0),
            cache_read_input_tokens:   (map(.cache_read_input_tokens // 0)   | add // 0),
            cache_creation_input_tokens: (map(.cache_creation_input_tokens // 0) | add // 0)
          }
      ' 2>/dev/null || echo '{}')
else
  USAGE='{}'
fi

curl -sf -X POST "${SERVER_URL}/session/stop" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\": \"$SESSION_ID\", \"usage\": $USAGE}" > /dev/null 2>&1 || true

exit 0
