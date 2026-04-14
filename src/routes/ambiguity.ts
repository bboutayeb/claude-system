import { db } from "../db"
import { parseDays } from "./dashboard"
import { loadAllowlist } from "./user-prompt"

export async function handleAmbiguityList(url: URL): Promise<Response> {
  const days = parseDays(url)
  const { rows } = await db.query(
    `SELECT id, session_id, prompt_text, suggestion, source, detected_at, false_positive
     FROM ambiguities
     WHERE detected_at >= CURRENT_DATE - $1::int
     ORDER BY detected_at DESC
     LIMIT 50`,
    [days]
  )
  return new Response(JSON.stringify({ ambiguities: rows }), {
    headers: { "Content-Type": "application/json" },
  })
}

export async function handleAmbiguityFeedback(body: unknown): Promise<Response> {
  const { id } = body as { id?: unknown }

  if (typeof id !== "number") {
    return new Response(
      JSON.stringify({ error: "id (number) required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  // Toggle cycle: NULL → true → NULL — single atomic update avoids race condition
  const { rows } = await db.query(
    `UPDATE ambiguities
     SET false_positive = CASE WHEN false_positive = true THEN NULL ELSE true END
     WHERE id = $1
     RETURNING false_positive`,
    [id]
  )

  if (rows.length === 0) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })
  }

  // Refresh in-memory allowlist after each feedback
  loadAllowlist().catch(() => {})

  return new Response(JSON.stringify({ ok: true, false_positive: rows[0].false_positive }), {
    headers: { "Content-Type": "application/json" },
  })
}
