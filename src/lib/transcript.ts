type ContentBlock = { type: string; text?: string }

/** Parse a JSONL buffer (array of raw lines) into valid JSON entries, skipping blanks and parse errors. */
export function parseJSONLLines(lines: string[]): unknown[] {
  const result: unknown[] = []
  for (const l of lines) {
    if (!l.trim()) continue
    try { result.push(JSON.parse(l)) } catch { /* skip malformed */ }
  }
  return result
}

/** Normalize a message content field (string | Block[] | unknown) to plain text. */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter(b => b != null && typeof b === "object" && b.type === "text")
      .map(b => b.text ?? "")
      .join("\n")
  }
  return ""
}
