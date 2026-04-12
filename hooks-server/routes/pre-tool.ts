import Anthropic from "@anthropic-ai/sdk"
import { db } from "../db"

const client = new Anthropic()

const AMBIGUITY_TRIGGERS = [
  /\b(this|that|it|them|those|these)\b/i,
  /\b(redo|undo|revert|retry)\b/i,
  /\bthe (recommendations?|suggestions?|changes?)\b/i,
]

function isAmbiguous(text: string): boolean {
  return text.length < 30 || AMBIGUITY_TRIGGERS.some((r) => r.test(text))
}

async function getSuggestion(text: string): Promise<string | null> {
  const haiku = client.messages
    .create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      system:
        "You detect ambiguous prompts. Respond with ONE short clarifying question (max 15 words). If the text is already clear and specific, respond with an empty string.",
      messages: [{ role: "user", content: text }],
    })
    .catch(() => null)

  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 400))
  const result = await Promise.race([haiku, timeout])

  if (!result) return null
  const suggestion =
    result.content[0]?.type === "text" ? result.content[0].text.trim() : null
  return suggestion && suggestion.length > 0 ? suggestion : null
}

export async function handlePreTool(body: unknown): Promise<Response> {
  const { session_id, tool_name, tool_input } = body as {
    session_id?: string
    tool_name?: string
    tool_input?: { prompt?: string; command?: string }
  }

  const text = tool_input?.prompt ?? tool_input?.command ?? ""
  if (!text || !isAmbiguous(text)) {
    return new Response("{}", { headers: { "Content-Type": "application/json" } })
  }

  const suggestion = await getSuggestion(text)

  // Log to DB — fire-and-forget, never block
  db.query(
    "INSERT INTO ambiguities (session_id, tool_name, prompt_text, suggestion) VALUES ($1, $2, $3, $4)",
    [session_id ?? null, tool_name ?? null, text.slice(0, 500), suggestion]
  ).catch(() => {})

  if (suggestion) {
    return new Response(JSON.stringify({ suggestion }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  return new Response("{}", { headers: { "Content-Type": "application/json" } })
}
