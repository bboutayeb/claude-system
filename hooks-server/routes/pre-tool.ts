import { timers } from "../timers"

export async function handlePreTool(body: unknown): Promise<Response> {
  const { tool_use_id } = body as { tool_use_id?: string }

  if (tool_use_id) {
    timers.set(tool_use_id, Date.now())
  }

  return new Response("{}", { headers: { "Content-Type": "application/json" } })
}
