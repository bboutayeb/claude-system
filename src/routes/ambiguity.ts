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
  const { id } = body as { id?: unknown }

  if (typeof id !== "number") {
    return new Response(
      JSON.stringify({ error: "id (number) required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  // Toggle cycle: NULL → true → NULL
  // Query current state, then flip it
  const { rows: current } = await db.query(
    "SELECT false_positive FROM ambiguities WHERE id = $1",
    [id]
  )

  if (current.length === 0) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })
  }

  const currentValue = current[0].false_positive as boolean | null
  const newValue = currentValue === true ? null : true

  await db.query(
    "UPDATE ambiguities SET false_positive = $1 WHERE id = $2",
    [newValue, id]
  )

  // Refresh in-memory allowlist after each feedback
  loadAllowlist().catch(() => {})

  return new Response(JSON.stringify({ ok: true, false_positive: newValue }), {
    headers: { "Content-Type": "application/json" },
  })
}
