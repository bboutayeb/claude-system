import { db } from "../db"
import { config } from "../config"
import { scoreExchange } from "./quality-scorer"
import { calcHaikuCost } from "../lib/haiku-usage"
import { parseJSONLLines, extractTextFromContent } from "../lib/transcript"
import { getAnthropicClient } from "../lib/anthropic-client"

// ─── In-memory session state ──────────────────────────────────────────────────

interface SessionState {
  lastPromptTs: number
  lastScoreTs: number   // updated only on successful score — guards "new prompt since last score"
  lastAttemptTs: number // updated on every attempt — drives the throttle
  pendingPromptId: number | null
  transcriptPath: string | null
  inFlight: boolean
}

const sessions = new Map<string, SessionState>()

// ─── JSONL parsing ────────────────────────────────────────────────────────────

interface Exchange { prompt: string; response: string }

function extractLastExchange(lines: string[]): Exchange | null {
  const entries = parseJSONLLines(lines)

  // Scan backward — parse lazily so we stop as soon as we have one exchange
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as Record<string, unknown>
    const isAssistant = (e?.message as Record<string, unknown>)?.role === "assistant" || e?.type === "assistant"
    if (!isAssistant) continue

    const responseText = extractTextFromContent((e.message as Record<string, unknown>)?.content ?? e.content)
    if (!responseText) continue

    // Find preceding user message (skip tool_result entries)
    for (let j = i - 1; j >= 0; j--) {
      const u = entries[j] as Record<string, unknown>
      const isUser = u?.type === "user" || (u?.message as Record<string, unknown>)?.role === "user"
      if (!isUser) continue
      const c = (u?.message as Record<string, unknown>)?.content
      if (Array.isArray(c) && c.some((b: { type: string }) => b.type === "tool_result")) continue

      const promptText = extractTextFromContent((u.message as Record<string, unknown>)?.content ?? u.content)
      if (promptText) return { prompt: promptText, response: responseText }
      break
    }
  }

  return null
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function markNewPrompt(sessionId: string, promptId: number): void {
  const s = sessions.get(sessionId)
  if (s) {
    s.lastPromptTs = Date.now()
    s.pendingPromptId = promptId
  } else {
    sessions.set(sessionId, { lastPromptTs: Date.now(), lastScoreTs: 0, lastAttemptTs: 0, pendingPromptId: promptId, transcriptPath: null, inFlight: false })
  }
}

export async function maybeScore(sessionId: string): Promise<void> {
  if (!config.realtime_scoring) return
  const api = getAnthropicClient()
  if (!api) return

  const s = sessions.get(sessionId)
  if (!s) return

  if (s.lastPromptTs <= s.lastScoreTs) return
  if (s.inFlight) return

  const throttleMs = config.realtime_scoring_throttle_s * 1000
  if (Date.now() - s.lastAttemptTs < throttleMs) return

  s.inFlight = true
  const capturedPromptTs = s.lastPromptTs
  try {
    s.lastAttemptTs = Date.now()

    if (!s.transcriptPath) {
      const { rows } = await db.query(
        "SELECT transcript_path FROM sessions WHERE id = $1",
        [sessionId]
      )
      s.transcriptPath = rows[0]?.transcript_path ?? null
      if (!s.transcriptPath) return
    }

    const promptId = s.pendingPromptId
    if (!promptId) return

    const file = Bun.file(s.transcriptPath)
    const tailBytes = 64 * 1024
    const text = await file.slice(Math.max(0, file.size - tailBytes), file.size).text()
    const lines = text.split("\n")
    const exchange = extractLastExchange(lines)
    if (!exchange) return

    const { score, inputTokens, outputTokens } = await scoreExchange(api, exchange.prompt, exchange.response)

    const updateResult = await db.query(
      "UPDATE prompts SET quality_score = $1 WHERE id = $2 AND quality_score IS NULL",
      [score, promptId]
    )

    const cost = calcHaikuCost(inputTokens, outputTokens)
    await db.query(
      "INSERT INTO haiku_usage (source, input_tokens, output_tokens, cost_usd) VALUES ($1, $2, $3, $4)",
      ["realtime-scoring", inputTokens, outputTokens, cost]
    )

    // Mark scored only after telemetry is persisted
    s.lastScoreTs = capturedPromptTs
    if ((updateResult.rowCount ?? 0) > 0) {
      if (s.pendingPromptId === promptId) s.pendingPromptId = null
      console.log(`[realtime-scorer] session=${sessionId} score=${score}`)
    }
  } catch (err: unknown) {
    console.error(`[realtime-scorer] error: ${(err as Error).message}`)
  } finally {
    s.inFlight = false
  }
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId)
}
