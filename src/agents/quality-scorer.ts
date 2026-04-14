import { Pool } from "pg"
import Anthropic from "@anthropic-ai/sdk"
import { config } from "../config"
import { calcHaikuCost } from "../lib/haiku-usage"

interface PromptRow {
  id: number
  prompt_text: string
  session_id: string
  transcript_path: string
}

// ─── Transcript parsing ───────────────────────────────────────────────────────

function findAssistantResponse(lines: string[], promptText: string): string | null {
  const entries = lines
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const isUser = e?.type === "user" || e?.message?.role === "user"
    if (isUser) {
      const content = e.message?.content ?? e.content
      const text = typeof content === "string" ? content
        : Array.isArray(content) ? content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n")
        : null
      if (typeof text === "string" && text.includes(promptText.slice(0, 100))) {
        for (let j = i + 1; j < entries.length; j++) {
          const next = entries[j]
          // Stop at next real human message (not tool_result)
          if (next?.type === "user" || next?.message?.role === "user") {
            const c = next?.message?.content
            const isToolResult = Array.isArray(c) && c.some((b: { type: string }) => b.type === "tool_result")
            if (!isToolResult) break
          }
          const isAssistant = next?.message?.role === "assistant" || next?.type === "assistant"
          if (isAssistant) {
            const resp = next.message?.content
            if (typeof resp === "string" && resp) return resp
            if (Array.isArray(resp)) {
              const text = resp
                .filter((b: { type: string }) => b.type === "text")
                .map((b: { text: string }) => b.text)
                .join("\n")
              if (text) return text  // skip thinking-only blocks, keep looking
            }
          }
        }
      }
    }
  }
  return null
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

export interface ScoreResult {
  score: number
  inputTokens: number
  outputTokens: number
}

export async function scoreExchange(client: Anthropic, prompt: string, response: string): Promise<ScoreResult> {
  const result = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 10,
    system: `You are a quality scorer for AI coding assistant interactions.
Rate the quality of this prompt+response pair on a scale from 1 to 10.
Consider: clarity of the prompt, completeness and relevance of the response,
and whether the response actually addresses the request.
Respond with ONLY a single integer from 1 to 10. Nothing else.`,
    messages: [{
      role: "user",
      content: `PROMPT: ${prompt.slice(0, 500)}\n\nRESPONSE: ${response.slice(0, 2000)}`,
    }],
  })
  const text = result.content[0]?.type === "text" ? result.content[0].text.trim() : ""
  const score = parseInt(text, 10)
  return {
    score: score >= 1 && score <= 10 ? score : 5,
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
  }
}

// ─── Core scoring logic ───────────────────────────────────────────────────────

async function scorePrompts(
  pool: Pool,
  client: Anthropic,
  prompts: PromptRow[]
): Promise<{ scored: number; skipped: number }> {
  let scored = 0
  let skipped = 0

  for (const row of prompts) {
    try {
      const file = Bun.file(row.transcript_path)
      if (!await file.exists()) {
        console.log(`  [SKIP] #${row.id} — transcript not found: ${row.transcript_path}`)
        skipped++
        continue
      }

      const text = await file.text()
      const lines = text.split("\n")
      const response = findAssistantResponse(lines, row.prompt_text)

      if (!response) {
        console.log(`  [SKIP] #${row.id} — no matching assistant response in transcript`)
        skipped++
        continue
      }

      const { score, inputTokens, outputTokens } = await scoreExchange(client, row.prompt_text, response)
      const cost = calcHaikuCost(inputTokens, outputTokens)
      await Promise.all([
        pool.query("UPDATE prompts SET quality_score = $1 WHERE id = $2", [score, row.id]),
        pool.query(
          "INSERT INTO haiku_usage (source, input_tokens, output_tokens, cost_usd) VALUES ($1, $2, $3, $4)",
          ["scoring", inputTokens, outputTokens, cost]
        ),
      ])
      console.log(`  [OK]   #${row.id} score=${score}`)
      scored++

      await new Promise(r => setTimeout(r, 200))
    } catch (err: unknown) {
      const error = err as Error
      console.error(`  [ERR]  #${row.id} — ${error.message}`)
    }
  }

  return { scored, skipped }
}

// ─── Exported functions ───────────────────────────────────────────────────────

export async function scoreSession(sessionId: string, maxPrompts = 50): Promise<void> {
  if (!config.anthropic_api_key) {
    console.log("[quality-scorer] ANTHROPIC_API_KEY not set — skipping")
    return
  }

  const pool = new Pool({ connectionString: config.db_url })
  const client = new Anthropic({ apiKey: config.anthropic_api_key })

  try {
    const { rows: prompts } = await pool.query<PromptRow>(
      `SELECT p.id, p.prompt_text, p.session_id, s.transcript_path
       FROM prompts p
       JOIN sessions s ON p.session_id = s.id
       WHERE p.quality_score IS NULL
         AND p.session_id = $1
         AND s.transcript_path IS NOT NULL
       ORDER BY p.created_at DESC
       LIMIT $2`,
      [sessionId, maxPrompts]
    )

    if (prompts.length === 0) {
      console.log(`[quality-scorer] no unscored prompts for session ${sessionId}`)
      return
    }

    console.log(`[quality-scorer] scoring ${prompts.length} prompt(s) for session ${sessionId}`)
    const { scored, skipped } = await scorePrompts(pool, client, prompts)
    console.log(`[quality-scorer] ${scored} scored, ${skipped} skipped`)
  } finally {
    await pool.end()
  }
}

export async function runAll(maxPrompts = 20): Promise<void> {
  if (!config.anthropic_api_key) {
    console.log("[quality-scorer] ANTHROPIC_API_KEY not set — skipping")
    return
  }

  const pool = new Pool({ connectionString: config.db_url })
  const client = new Anthropic({ apiKey: config.anthropic_api_key })

  try {
    const { rows: prompts } = await pool.query<PromptRow>(
      `SELECT p.id, p.prompt_text, p.session_id, s.transcript_path
       FROM prompts p
       JOIN sessions s ON p.session_id = s.id
       WHERE p.quality_score IS NULL
         AND s.transcript_path IS NOT NULL
       ORDER BY p.created_at DESC
       LIMIT $1`,
      [maxPrompts]
    )

    if (prompts.length === 0) {
      console.log("No unscored prompts with transcripts.")
      return
    }

    console.log(`Scoring ${prompts.length} prompt(s)...`)
    const { scored, skipped } = await scorePrompts(pool, client, prompts)
    console.log(`\n${scored} scored, ${skipped} skipped`)
  } finally {
    await pool.end()
  }
}
