type ContentBlock = { type: string; text?: string }

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
