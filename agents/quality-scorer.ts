import { Pool } from "pg"
import Anthropic from "@anthropic-ai/sdk"

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://claude:claude@localhost:5432/claude_system",
})

const client = new Anthropic()

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
    // User message matching the prompt
    if (e?.type === "human" || e?.role === "user") {
      const content = typeof e.message?.content === "string"
        ? e.message.content
        : e.content
      if (typeof content === "string" && content.includes(promptText.slice(0, 100))) {
        // Find next assistant message
        for (let j = i + 1; j < entries.length; j++) {
          const next = entries[j]
          if (next?.type === "assistant" || next?.role === "assistant") {
            const resp = next.message?.content ?? next.content
            if (typeof resp === "string") return resp
            if (Array.isArray(resp)) {
              return resp
                .filter((b: { type: string }) => b.type === "text")
                .map((b: { text: string }) => b.text)
                .join("\n")
            }
          }
        }
      }
    }
  }
  return null
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

async function scoreExchange(prompt: string, response: string): Promise<number> {
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
  return score >= 1 && score <= 10 ? score : 5
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runAll() {
  const { rows: prompts } = await pool.query<PromptRow>(
    `SELECT p.id, p.prompt_text, p.session_id, s.transcript_path
     FROM prompts p
     JOIN sessions s ON p.session_id = s.id
     WHERE p.quality_score IS NULL
       AND s.transcript_path IS NOT NULL
     ORDER BY p.created_at DESC
     LIMIT 50`
  )

  if (prompts.length === 0) {
    console.log("No unscored prompts with transcripts.")
    await pool.end()
    return
  }

  console.log(`Scoring ${prompts.length} prompt(s)...`)
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

      const score = await scoreExchange(row.prompt_text, response)
      await pool.query("UPDATE prompts SET quality_score = $1 WHERE id = $2", [score, row.id])
      console.log(`  [OK]   #${row.id} score=${score}`)
      scored++

      // Rate limiting
      await new Promise(r => setTimeout(r, 200))
    } catch (err: unknown) {
      const error = err as Error
      console.error(`  [ERR]  #${row.id} — ${error.message}`)
    }
  }

  console.log(`\n${scored} scored, ${skipped} skipped`)
  await pool.end()
}

runAll().catch((err) => {
  console.error("[quality-scorer] fatal:", err.message)
  process.exit(1)
})
