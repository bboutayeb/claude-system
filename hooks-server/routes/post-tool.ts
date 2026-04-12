import { db } from "../db"

interface PostToolPayload {
  session_id?: string
  tool_name?: string
  tool_use_id?: string
  duration_ms?: number
  usage?: {
    input_tokens?: number
  }
}

export async function handlePostTool(body: unknown): Promise<Response> {
  const payload = body as PostToolPayload
  const { session_id, tool_name, duration_ms } = payload

  if (!session_id || !tool_name) {
    return new Response("missing session_id or tool_name", { status: 400 })
  }

  // Ensure session exists (may not if server was restarted mid-session)
  await db.query(
    "INSERT INTO sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
    [session_id]
  )

  await db.query(
    `INSERT INTO tool_calls (session_id, tool_name, duration_ms, input_tokens)
     VALUES ($1, $2, $3, $4)`,
    [
      session_id,
      tool_name,
      duration_ms ?? null,
      payload.usage?.input_tokens ?? 0,
    ]
  )
  return new Response("ok")
}
