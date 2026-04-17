import Anthropic from "@anthropic-ai/sdk"
import { config } from "../config"

let client: Anthropic | null = null

export function getAnthropicClient(): Anthropic | null {
  if (!config.anthropic_api_key) return null
  if (!client) client = new Anthropic({ apiKey: config.anthropic_api_key })
  return client
}
