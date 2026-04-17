import { db } from "../db"
import { config } from "../config"
import { calcHaikuCost } from "../lib/haiku-usage"
import { markNewPrompt } from "../agents/realtime-scorer"
import { getAnthropicClient } from "../lib/anthropic-client"

const AMBIGUITY_TRIGGERS = [
  // Déictiques purs — ambigus par construction, sans référent syntaxique
  // ça/ceci/cela: in JavaScript, \b is based on ASCII \w only; the u flag does not
  // make it Unicode-aware, so use explicit ASCII word-boundary lookaround instead
  /(?<![a-zA-Z0-9_])(ça|ceci|cela)(?![a-zA-Z0-9_])/i,
  // Back-references à une liste passée — quasi-toujours ambigus sans contexte
  /\bles? (recommandations?|suggestions?)\b/i,
]

const FALLBACK_REASON_FR =
  "Votre prompt semble ambigu. Pourriez-vous préciser ce que vous souhaitez faire ?"
const FALLBACK_REASON_EN =
  "Your prompt seems ambiguous. Could you clarify what you'd like to do?"

function getFallbackReason(text: string): string {
  return /[àâéèêëïîôùûüç]|\b(le|la|les|un|une|des|du|je|tu|il|nous|vous|ils)\b/i.test(text)
    ? FALLBACK_REASON_FR
    : FALLBACK_REASON_EN
}

// Only scan the instruction prefix — pasted context/assistant text follows later
const AMBIGUITY_SCAN_LENGTH = 500
// Haiku only needs the instruction to judge intent — caps latency and cost
const HAIKU_PROMPT_LENGTH = 800

// Slash commands (/compact, /help, /clear, etc.) must never be blocked
const SLASH_COMMAND_RE = /^\/\w+/

// User-defined allowlist — populated from DB (ambiguities marked as false positives)
const ALLOWLISTED_RESPONSES = new Set<string>([])

export async function loadAllowlist(): Promise<void> {
  const { rows } = await db.query(
    "SELECT prompt_text FROM ambiguities WHERE false_positive = true"
  )
  ALLOWLISTED_RESPONSES.clear()
  for (const row of rows) {
    ALLOWLISTED_RESPONSES.add((row.prompt_text as string).slice(0, 500).toLowerCase())
  }
}

function isAllowlisted(text: string): boolean {
  const t = text.trim()
  return SLASH_COMMAND_RE.test(t) || ALLOWLISTED_RESPONSES.has(t.slice(0, 500).toLowerCase())
}

function isAmbiguous(text: string): boolean {
  const trimmed = text.trim()
  // Short prompt: always ambiguous regardless of content (aligned with article: < 30 chars)
  if (trimmed.length < 30) return true
  // Longer prompt: only flag on explicit ambiguous keywords
  return AMBIGUITY_TRIGGERS.some((r) => r.test(trimmed.slice(0, AMBIGUITY_SCAN_LENGTH)))
}

type SuggestionResult =
  | { status: "question"; text: string }  // Haiku generated a clarifying question
  | { status: "clear" }                   // Haiku says prompt is clear
  | { status: "unavailable" }             // timeout, error, or no API key

async function getSuggestion(text: string, sessionId: string | null): Promise<SuggestionResult> {
  const client = getAnthropicClient()
  if (!client) return { status: "unavailable" }

  // Enrich context with the last clear prompt from this session (like the article's RAG step)
  let content = text.slice(0, HAIKU_PROMPT_LENGTH)
  if (sessionId) {
    try {
      const result = await db.query(
        "SELECT prompt_text FROM prompts WHERE session_id = $1 AND NOT is_ambiguous ORDER BY created_at DESC LIMIT 1",
        [sessionId]
      )
      const row = result.rows[0]
      if (row?.prompt_text) {
        const prev = (row.prompt_text as string).slice(0, 400)
        content = `Previous clear prompt: ${prev}\n\nCurrent prompt: ${text.slice(0, HAIKU_PROMPT_LENGTH - prev.length - 92)}`
      }
    } catch { /* fail open — use original text */ }
  }

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 3000)

  try {
    const result = await client.messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 80,
        system:
          "You detect ambiguous prompts. Respond with ONE short clarifying question (max 20 words). Respond in the same language as the input. If the text is already clear and specific, respond with an empty string.",
        messages: [{ role: "user", content }],
      },
      { signal: abort.signal }
    )

    const { input_tokens, output_tokens } = result.usage
    const cost = calcHaikuCost(input_tokens, output_tokens)
    db.query(
      "INSERT INTO haiku_usage (source, input_tokens, output_tokens, cost_usd) VALUES ($1, $2, $3, $4)",
      ["ambiguity", input_tokens, output_tokens, cost]
    ).then(() => checkHaikuAlert()).catch(() => {})

    const text_ = result.content[0]?.type === "text" ? result.content[0].text.trim() : ""
    return text_.length > 0 ? { status: "question", text: text_ } : { status: "clear" }
  } catch {
    return { status: "unavailable" }
  } finally {
    clearTimeout(timer)
  }
}

let lastAlertCheck = 0

function checkHaikuAlert(): void {
  const limit = config.haiku_cost_alert_usd
  if (limit == null) return
  const now = Date.now()
  if (now - lastAlertCheck < 60_000) return
  lastAlertCheck = now
  db.query(
    "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM haiku_usage WHERE created_at >= CURRENT_DATE",
    []
  ).then(({ rows }) => {
    const total = parseFloat(rows[0]?.total ?? "0")
    if (total >= limit) {
      console.warn(`[claude-monitor] WARNING: Haiku daily cost $${total.toFixed(4)} >= alert threshold $${limit}`)
    }
  }).catch(() => {})
}

export async function handleUserPrompt(body: unknown): Promise<Response> {
  const { session_id, prompt } = body as {
    session_id?: string
    prompt?: string
  }

  if (!prompt) {
    return new Response("{}", { headers: { "Content-Type": "application/json" } })
  }

  // Slash commands and short valid responses bypass ambiguity detection entirely
  if (isAllowlisted(prompt)) {
    db.query(
      "INSERT INTO prompts (session_id, prompt_text, is_ambiguous) VALUES ($1, $2, $3) RETURNING id",
      [session_id ?? null, prompt.slice(0, 2000), false]
    ).then(({ rows }) => { if (session_id && rows[0]?.id) markNewPrompt(session_id, rows[0].id) }).catch(() => {})
    return new Response("{}", { headers: { "Content-Type": "application/json" } })
  }

  const ambiguous = isAmbiguous(prompt)

  db.query(
    "INSERT INTO prompts (session_id, prompt_text, is_ambiguous) VALUES ($1, $2, $3) RETURNING id",
    [session_id ?? null, prompt.slice(0, 2000), ambiguous]
  ).then(({ rows }) => { if (session_id && rows[0]?.id) markNewPrompt(session_id, rows[0].id) }).catch(() => {})

  if (!ambiguous) {
    return new Response("{}", { headers: { "Content-Type": "application/json" } })
  }

  const suggestion = await getSuggestion(prompt, session_id ?? null)

  // Haiku explicitly says clear → trust it regardless of length
  if (suggestion.status === "clear") {
    return new Response("{}", { headers: { "Content-Type": "application/json" } })
  }

  const reason = suggestion.status === "question"
    ? `[IA] ${suggestion.text}`
    : `[heuristique] ${getFallbackReason(prompt)}`

  const source = suggestion.status === "question" ? "ia" : "heuristique"

  db.query(
    "INSERT INTO ambiguities (session_id, tool_name, prompt_text, suggestion, source) VALUES ($1, $2, $3, $4, $5)",
    [session_id ?? null, null, prompt.slice(0, 500), reason, source]
  ).catch(() => {})

  return new Response(
    JSON.stringify({ decision: "block", reason }),
    { headers: { "Content-Type": "application/json" } }
  )
}
