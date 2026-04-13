import { db } from "../db"
import { loadAllowlist } from "./user-prompt"

export async function handleAmbiguityList(url: URL): Promise<Response> {
  const days = parseInt(url.searchParams.get("days") ?? "7") || 7
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
  const { id, false_positive } = body as { id?: unknown; false_positive?: unknown }

  if (typeof id !== "number" || typeof false_positive !== "boolean") {
    return new Response(
      JSON.stringify({ error: "id (number) and false_positive (boolean) required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  const { rows } = await db.query(
    "UPDATE ambiguities SET false_positive = $1 WHERE id = $2 RETURNING id",
    [false_positive, id]
  )

  if (rows.length === 0) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })
  }

  // Refresh in-memory allowlist after each feedback
  loadAllowlist().catch(() => {})

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  })
}
