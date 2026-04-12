import Anthropic from "@anthropic-ai/sdk"
import { db } from "../db"

const client = new Anthropic()

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

function isAmbiguous(text: string): boolean {
  return text.length < 30 || AMBIGUITY_TRIGGERS.some((r) => r.test(text))
}

async function getSuggestion(text: string): Promise<string | null> {
  const haiku = client.messages
    .create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      system:
        "You detect ambiguous prompts. Respond with ONE short clarifying question (max 15 words). Respond in the same language as the input. If the text is already clear and specific, respond with an empty string.",
      messages: [{ role: "user", content: text }],
    })
    .catch(() => null)

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), 400)
  )
  const result = await Promise.race([haiku, timeout])

  if (!result) return null
  const suggestion =
    result.content[0]?.type === "text" ? result.content[0].text.trim() : null
  return suggestion && suggestion.length > 0 ? suggestion : null
}

export async function handleUserPrompt(body: unknown): Promise<Response> {
  const { session_id, prompt } = body as {
    session_id?: string
    prompt?: string
  }

  if (!prompt || !isAmbiguous(prompt)) {
    return new Response("{}", { headers: { "Content-Type": "application/json" } })
  }

  const suggestion = await getSuggestion(prompt)

  // Haiku said it's clear (empty response) → let it through
  if (suggestion === null && prompt.length >= 15) {
    return new Response("{}", { headers: { "Content-Type": "application/json" } })
  }

  const reason = suggestion ?? FALLBACK_REASON

  // Log to DB — fire-and-forget
  db.query(
    "INSERT INTO ambiguities (session_id, tool_name, prompt_text, suggestion) VALUES ($1, $2, $3, $4)",
    [session_id ?? null, null, prompt.slice(0, 500), reason]
  ).catch(() => {})

  return new Response(
    JSON.stringify({ decision: "block", reason }),
    { headers: { "Content-Type": "application/json" } }
  )
}
