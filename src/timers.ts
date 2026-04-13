// Shared in-memory timers to measure tool call duration.
// PreToolUse sets the start time; PostToolUse reads and clears it.
export const timers = new Map<string, number>()
