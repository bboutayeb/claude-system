import { db } from "../db"

export async function handleSessionStart(body: unknown): Promise<Response> {
  const { session_id, model, source, agent_type } = body as {
    session_id?: string
    model?: string
    source?: string
    agent_type?: string
  }
  if (!session_id) return new Response("missing session_id", { status: 400 })

  await db.query(
    `INSERT INTO sessions (id, model, source, agent_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       model      = COALESCE(EXCLUDED.model, sessions.model),
       source     = COALESCE(EXCLUDED.source, sessions.source),
       agent_type = COALESCE(EXCLUDED.agent_type, sessions.agent_type)`,
    [session_id, model ?? null, source ?? null, agent_type ?? null]
  )
  console.log(`[session] started: ${session_id} model=${model} source=${source}`)
  return new Response("ok")
}

export async function handleSessionStop(body: unknown): Promise<Response> {
  const { session_id, usage } = body as {
    session_id?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  if (!session_id) return new Response("missing session_id", { status: 400 })

  await db.query(
    `UPDATE sessions SET
      ended_at = now(),
      input_tokens = COALESCE($2, 0),
      output_tokens = COALESCE($3, 0),
      cache_read_tokens = COALESCE($4, 0),
      cache_write_tokens = COALESCE($5, 0)
    WHERE id = $1`,
    [
      session_id,
      usage?.input_tokens ?? 0,
      usage?.output_tokens ?? 0,
      usage?.cache_read_input_tokens ?? 0,
      usage?.cache_creation_input_tokens ?? 0,
    ]
  )
  console.log(`[session] stopped: ${session_id}`)
  return new Response("ok")
}
