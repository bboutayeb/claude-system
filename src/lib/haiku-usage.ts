// Haiku pricing constants and cost calculation.
// These are the only place where pricing is defined — both call sites import from here.

const INPUT_COST_PER_MTOK = 0.80   // USD per million input tokens
const OUTPUT_COST_PER_MTOK = 4.00  // USD per million output tokens

export function calcHaikuCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens * INPUT_COST_PER_MTOK + outputTokens * OUTPUT_COST_PER_MTOK) / 1_000_000
}
