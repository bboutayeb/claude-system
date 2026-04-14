import Anthropic from "@anthropic-ai/sdk"
import { db } from "../db"
import { config } from "../config"
import { scoreExchange } from "./quality-scorer"
import { calcHaikuCost } from "../lib/haiku-usage"

// ─── In-memory session state ──────────────────────────────────────────────────

interface SessionState {
  lastPromptTs: number
  lastScoreTs: number
  transcriptPath: string | null
  inFlight: boolean
}

const sessions = new Map<string, SessionState>()
let client: Anthropic | null = null

function getClient(): Anthropic | null {
  if (!config.anthropic_api_key) return null
  if (!client) client = new Anthropic({ apiKey: config.anthropic_api_key })
  return client
}

// ─── JSONL parsing ────────────────────────────────────────────────────────────

interface Exchange { prompt: string; response: string }

function extractRecentExchanges(lines: string[], count = 3): Exchange[] {
  const entries = lines
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)

  const exchanges: Exchange[] = []

  for (let i = entries.length - 1; i >= 0 && exchanges.length < count; i--) {
    const e = entries[i]
    const isAssistant = e?.message?.role === "assistant" || e?.type === "assistant"
    if (!isAssistant) continue

    const resp = e.message?.content
    let responseText = ""
    if (typeof resp === "string") responseText = resp
    else if (Array.isArray(resp)) {
      responseText = resp
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("\n")
    }
    if (!responseText) continue

    // Find preceding user message (skip tool_result entries)
    for (let j = i - 1; j >= 0; j--) {
      const u = entries[j]
      const isUser = u?.type === "user" || u?.message?.role === "user"
      if (!isUser) continue
      const c = u?.message?.content
      if (Array.isArray(c) && c.some((b: { type: string }) => b.type === "tool_result")) continue

      const content = u.message?.content ?? u.content
      const promptText = typeof content === "string" ? content
        : Array.isArray(content)
          ? content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n")
          : null
      if (promptText) exchanges.unshift({ prompt: promptText, response: responseText })
      break
    }
  }

  return exchanges
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function markNewPrompt(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s) {
    s.lastPromptTs = Date.now()
  } else {
    sessions.set(sessionId, { lastPromptTs: Date.now(), lastScoreTs: 0, transcriptPath: null, inFlight: false })
  }
}

export async function maybeScore(sessionId: string): Promise<void> {
  if (!config.realtime_scoring) return
  const api = getClient()
  if (!api) return

  const s = sessions.get(sessionId)
  if (!s) return

  if (s.lastPromptTs <= s.lastScoreTs) return
  if (s.inFlight) return

  const throttleMs = config.realtime_scoring_throttle_s * 1000
  if (Date.now() - s.lastScoreTs < throttleMs) return

  s.inFlight = true
  try {
    if (!s.transcriptPath) {
      const { rows } = await db.query(
        "SELECT transcript_path FROM sessions WHERE id = $1",
        [sessionId]
      )
      s.transcriptPath = rows[0]?.transcript_path ?? null
      if (!s.transcriptPath) return
    }

    const file = Bun.file(s.transcriptPath)
    if (!await file.exists()) return

    const tailBytes = 64 * 1024
    const text = await file.slice(Math.max(0, file.size - tailBytes), file.size).text()
    const lines = text.split("\n")
    const exchanges = extractRecentExchanges(lines, 3)
    if (exchanges.length === 0) return

    const last = exchanges[exchanges.length - 1]
    const { score, inputTokens, outputTokens } = await scoreExchange(api, last.prompt, last.response)

    const updateResult = await db.query(
      `UPDATE prompts SET quality_score = $1
       WHERE id = (
         SELECT id FROM prompts
         WHERE session_id = $2 AND quality_score IS NULL
         ORDER BY created_at DESC LIMIT 1
       )`,
      [score, sessionId]
    )

    if ((updateResult.rowCount ?? 0) === 0) return

    s.lastScoreTs = Date.now()
    const cost = calcHaikuCost(inputTokens, outputTokens)
    await db.query(
      "INSERT INTO haiku_usage (source, input_tokens, output_tokens, cost_usd) VALUES ($1, $2, $3, $4)",
      ["realtime-scoring", inputTokens, outputTokens, cost]
    )
    console.log(`[realtime-scorer] session=${sessionId} score=${score}`)
  } catch (err: unknown) {
    console.error(`[realtime-scorer] error: ${(err as Error).message}`)
  } finally {
    s.inFlight = false
  }
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId)
}
