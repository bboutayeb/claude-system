import Anthropic from "@anthropic-ai/sdk"
import { db } from "../db"
import { config } from "../config"
import { calcHaikuCost } from "../lib/haiku-usage"

const AMBIGUITY_TRIGGERS = [
  // English deictic references
  /\b(this|that|it|them|those|these)\b/i,
  /\b(redo|undo|revert|retry)\b/i,
  /\bthe (recommendations?|suggestions?|changes?)\b/i,
  // French deictic references + ambiguous verbs
  /\b(refaire|relancer|annuler|recommencer|implémenter)\b/i,
  /\b(ça|ceci|cela)\b/i,
  /\bles? (recommandations?|suggestions?|changements?|modifications?)\b/i,
]

const FALLBACK_REASON =
  "Votre prompt semble ambigu. Pourriez-vous préciser ce que vous souhaitez faire ?"

// Slash commands (/compact, /help, /clear, etc.) must never be blocked
const SLASH_COMMAND_RE = /^\/\w+/

// User-defined allowlist — populated via dashboard feedback (future feature)
const ALLOWLISTED_RESPONSES = new Set<string>([])

function isAllowlisted(text: string): boolean {
  const t = text.trim()
  return SLASH_COMMAND_RE.test(t) || ALLOWLISTED_RESPONSES.has(t.toLowerCase())
}

function isAmbiguous(text: string): boolean {
  const len = text.trim().length
  // Very short: always ambiguous
  if (len < 10) return true
  const matches = AMBIGUITY_TRIGGERS.filter((r) => r.test(text)).length
  // Medium length: one trigger is enough
  if (len < 40) return matches >= 1
  // Long prompt: require at least two independent signals
  return matches >= 2
}

type SuggestionResult =
  | { status: "question"; text: string }  // Haiku generated a clarifying question
  | { status: "clear" }                   // Haiku says prompt is clear
  | { status: "unavailable" }             // timeout, error, or no API key

async function getSuggestion(text: string): Promise<SuggestionResult> {
  if (!config.anthropic_api_key) return { status: "unavailable" }

  const client = new Anthropic({ apiKey: config.anthropic_api_key })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 1200)

  try {
    const result = await client.messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 80,
        system:
          "You detect ambiguous prompts. Respond with ONE short clarifying question (max 20 words). Respond in the same language as the input. If the text is already clear and specific, respond with an empty string.",
        messages: [{ role: "user", content: text }],
      },
      { signal: abort.signal }
    )

    // Track Haiku usage — fire-and-forget
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

function checkHaikuAlert(): void {
  const limit = config.haiku_cost_alert_usd
  if (limit == null) return
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
      "INSERT INTO prompts (session_id, prompt_text, is_ambiguous) VALUES ($1, $2, $3)",
      [session_id ?? null, prompt.slice(0, 2000), false]
    ).catch(() => {})
    return new Response("{}", { headers: { "Content-Type": "application/json" } })
  }

  const ambiguous = isAmbiguous(prompt)

  // Log every prompt — fire-and-forget
  db.query(
    "INSERT INTO prompts (session_id, prompt_text, is_ambiguous) VALUES ($1, $2, $3)",
    [session_id ?? null, prompt.slice(0, 2000), ambiguous]
  ).catch(() => {})

  if (!ambiguous) {
    return new Response("{}", { headers: { "Content-Type": "application/json" } })
  }

  const suggestion = await getSuggestion(prompt)

  // Haiku explicitly says clear → trust it regardless of length
  if (suggestion.status === "clear") {
    return new Response("{}", { headers: { "Content-Type": "application/json" } })
  }

  const reason = suggestion.status === "question"
    ? `[IA] ${suggestion.text}`
    : `[heuristique] ${FALLBACK_REASON}`

  const source = suggestion.status === "question" ? "ia" : "heuristique"

  // Log to ambiguities — fire-and-forget
  db.query(
    "INSERT INTO ambiguities (session_id, tool_name, prompt_text, suggestion, source) VALUES ($1, $2, $3, $4, $5)",
    [session_id ?? null, null, prompt.slice(0, 500), reason, source]
  ).catch(() => {})

  return new Response(
    JSON.stringify({ decision: "block", reason }),
    { headers: { "Content-Type": "application/json" } }
  )
}
