import { basename } from "path"
import { db } from "../db"
import { clearSession } from "../agents/realtime-scorer"

export async function handleSessionStart(body: unknown): Promise<Response> {
  const { session_id, model, source, agent_type, transcript_path, cwd } = body as {
    session_id?: string
    model?: string
    source?: string
    agent_type?: string
    transcript_path?: string
    cwd?: string
  }
  if (!session_id) return new Response("missing session_id", { status: 400 })

  const cwdText = typeof cwd === "string" ? cwd : null
  const rawBase = cwdText ? basename(cwdText) : null
  const project = rawBase && rawBase !== "/" ? rawBase : null

  await db.query(
    `INSERT INTO sessions (id, model, source, agent_type, transcript_path, cwd, project)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       model           = COALESCE(EXCLUDED.model, sessions.model),
       source          = COALESCE(EXCLUDED.source, sessions.source),
       agent_type      = COALESCE(EXCLUDED.agent_type, sessions.agent_type),
       transcript_path = COALESCE(EXCLUDED.transcript_path, sessions.transcript_path),
       cwd             = COALESCE(EXCLUDED.cwd, sessions.cwd),
       project         = COALESCE(EXCLUDED.project, sessions.project)`,
    [session_id, model ?? null, source ?? null, agent_type ?? null, transcript_path ?? null, cwdText, project]
  )
  console.log(`[session] started: ${session_id} model=${model} project=${project ?? '—'} source=${source}`)
  return new Response("ok")
}

export async function handleSessionStop(body: unknown): Promise<Response> {
  const { session_id, transcript_path, usage } = body as {
    session_id?: string
    transcript_path?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  if (!session_id) return new Response("missing session_id", { status: 400 })

  try {
    await db.query(
      `UPDATE sessions SET
        ended_at = now(),
        input_tokens = COALESCE($2, 0),
        output_tokens = COALESCE($3, 0),
        cache_read_tokens = COALESCE($4, 0),
        cache_write_tokens = COALESCE($5, 0),
        transcript_path = COALESCE($6, transcript_path)
      WHERE id = $1`,
      [
        session_id,
        usage?.input_tokens ?? 0,
        usage?.output_tokens ?? 0,
        usage?.cache_read_input_tokens ?? 0,
        usage?.cache_creation_input_tokens ?? 0,
        transcript_path ?? null,
      ]
    )
  } finally {
    clearSession(session_id)
  }
  console.log(`[session] stopped: ${session_id}`)
  return new Response("ok")
}
