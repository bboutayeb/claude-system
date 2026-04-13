// Parses a Claude Code transcript JSONL file and aggregates token usage.
// Replaces the `grep | jq -sc` pipeline in session-stop.sh.

interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export async function aggregateTranscriptTokens(transcriptPath: string): Promise<TokenUsage> {
  const zero: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }

  try {
    const file = Bun.file(transcriptPath)
    if (!await file.exists()) return zero

    const text = await file.text()
    const lines = text.split("\n").filter(l => l.trim())

    return lines.reduce((acc, line) => {
      try {
        const entry = JSON.parse(line)
        const usage = entry?.message?.usage
        if (entry?.type === "assistant" && usage) {
          acc.input_tokens += usage.input_tokens ?? 0
          acc.output_tokens += usage.output_tokens ?? 0
          acc.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0
          acc.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0
        }
      } catch {
        // skip malformed lines
      }
      return acc
    }, { ...zero })
  } catch {
    return zero
  }
}
