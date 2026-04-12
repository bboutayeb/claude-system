// Phase 3 placeholder — ambiguity detection via Claude Haiku
// For now: just acknowledge and pass through (no blocking)

const AMBIGUITY_TRIGGERS = [
  /\b(this|that|it|them|those|these)\b/i,
  /\b(redo|undo|revert|retry)\b/i,
  /\bthe (recommendations?|suggestions?|changes?)\b/i,
]

function isAmbiguous(text: string): boolean {
  return text.length < 30 || AMBIGUITY_TRIGGERS.some((r) => r.test(text))
}

export async function handlePreTool(body: unknown): Promise<Response> {
  const { tool_input } = body as { tool_input?: { prompt?: string; command?: string } }

  const text = tool_input?.prompt ?? tool_input?.command ?? ""
  if (text && isAmbiguous(text)) {
    // Non-blocking: print suggestion to stderr (visible in terminal)
    process.stderr.write(
      `[pre-tool] Ambiguous prompt detected: "${text.slice(0, 80)}"\n`
    )
  }

  // Always return empty object — hooks that return non-zero exit codes block tool use
  return new Response("{}", { headers: { "Content-Type": "application/json" } })
}
