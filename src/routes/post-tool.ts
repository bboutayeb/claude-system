import { db } from "../db"
import { timers } from "../timers"
import { maybeScore } from "../agents/realtime-scorer"

interface PostToolPayload {
  session_id?: string
  tool_name?: string
  tool_use_id?: string
}

export async function handlePostTool(body: unknown): Promise<Response> {
  const payload = body as PostToolPayload
  const { session_id, tool_name, tool_use_id } = payload
  const start = tool_use_id ? timers.get(tool_use_id) : undefined
  const duration_ms = start != null ? Date.now() - start : null
  if (tool_use_id) timers.delete(tool_use_id)

  if (!session_id || !tool_name) {
    return new Response("missing session_id or tool_name", { status: 400 })
  }

  // Ensure session exists (may not if server was restarted mid-session)
  await db.query(
    "INSERT INTO sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
    [session_id]
  )

  await db.query(
    `INSERT INTO tool_calls (session_id, tool_name, duration_ms)
     VALUES ($1, $2, $3)`,
    [session_id, tool_name, duration_ms ?? null]
  )
  if (session_id) maybeScore(session_id).catch(() => {})
  return new Response("ok")
}
