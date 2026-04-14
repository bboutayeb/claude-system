// Handles Claude Code lifecycle hook events.
// Replaces the 4 shell scripts in hooks/.
// Usage: claude-monitor hook <event-name>

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { aggregateTranscriptTokens } from "./transcript"
import { config, SERVER_URL, MONITOR_DIR, PID_FILE } from "../config"
import { homedir } from "os"

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString("utf8").trim()
  try {
    return JSON.parse(text || "{}")
  } catch {
    return {}
  }
}

async function isServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(500) })
    return res.ok
  } catch {
    return false
  }
}

async function ensureServerRunning(): Promise<void> {
  if (await isServerUp()) return

  if (!process.execPath.includes("claude-monitor")) {
    console.error("[hook] dev mode: server not running — start it manually: bun run src/cli.ts server")
    return
  }

  // Spawn self as server — detached so it survives hook process exit
  const proc = Bun.spawn([process.execPath, "server"], {
    cwd: MONITOR_DIR,
    detached: true,
    stdio: ["ignore", Bun.file(`/tmp/claude-monitor.log`), Bun.file(`/tmp/claude-monitor.log`)],
    env: {
      ...process.env,
      DATABASE_URL: config.db_url,
      HOOKS_PORT: String(config.port),
      ...(config.anthropic_api_key ? { ANTHROPIC_API_KEY: config.anthropic_api_key } : {}),
    },
  })
  proc.unref()

  // Wait up to 2s for the server to bind
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (await isServerUp()) return
  }
}

async function maybeRunVerifier(): Promise<void> {
  const cacheDir = process.env.XDG_CACHE_HOME ?? `${homedir()}/.cache`
  const lastRunFile = `${cacheDir}/claude-monitor-verifier-last-run`
  const now = Math.floor(Date.now() / 1000)
  let last = 0
  try { last = parseInt(readFileSync(lastRunFile, "utf8")) } catch {}

  if (now - last < 21600) return  // less than 6h ago

  writeFileSync(lastRunFile, String(now))

  const ageHours = Math.floor((now - last) / 3600)
  console.error(`[claude-monitor] running verifier (last run ${ageHours}h ago)`)

  Bun.spawn([process.execPath, "verify"], {
    detached: true,
    stdio: ["ignore", Bun.file("/tmp/claude-monitor-verifier.log"), Bun.file("/tmp/claude-monitor-verifier.log")],
    env: {
      ...process.env,
      DATABASE_URL: config.db_url,
      ...(config.anthropic_api_key ? { ANTHROPIC_API_KEY: config.anthropic_api_key } : {}),
    },
  }).unref()
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function onSessionStart(payload: Record<string, unknown>): Promise<void> {
  await ensureServerRunning()

  const body = {
    session_id: payload.session_id,
    model: payload.model,
    source: payload.source,
    agent_type: payload.agent_type,
    transcript_path: payload.transcript_path,
  }

  try {
    await fetch(`${SERVER_URL}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    })
  } catch {}

  // Show API key status in Claude console
  try {
    const res = await fetch(`${SERVER_URL}/status`, { signal: AbortSignal.timeout(1000) })
    const status = await res.json() as { apiKey?: boolean }
    if (status.apiKey) {
      console.error("[claude-monitor] server OK — ANTHROPIC_API_KEY present")
    } else {
      console.error("[claude-monitor] server OK — ANTHROPIC_API_KEY not set (Haiku disabled)")
    }
  } catch {
    console.error("[claude-monitor] server OK")
  }

  await maybeRunVerifier()
}

async function onSessionStop(payload: Record<string, unknown>): Promise<void> {
  const sessionId = (payload.session_id as string) ?? "unknown"
  const transcriptPath = (payload.transcript_path as string) ?? ""

  const usage = transcriptPath ? await aggregateTranscriptTokens(transcriptPath) : {}

  try {
    await fetch(`${SERVER_URL}/session/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, usage }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {}

  if (config.anthropic_api_key && sessionId !== "unknown") {
    Bun.spawn([process.execPath, "score-session", sessionId], {
      detached: true,
      stdio: ["ignore", Bun.file("/tmp/claude-monitor-scorer.log"), Bun.file("/tmp/claude-monitor-scorer.log")],
      env: {
        ...process.env,
        DATABASE_URL: config.db_url,
        ANTHROPIC_API_KEY: config.anthropic_api_key,
      },
    }).unref()
  }
}

async function onPreToolUse(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/pre-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1000),
    })
  } catch {}
  process.stdout.write("{}")
}

async function onPostToolUse(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/post-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1000),
    })
  } catch {}
}

async function onUserPromptSubmit(payload: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${SERVER_URL}/user-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    })
    const text = await res.text()
    process.stdout.write(text)
  } catch {
    process.stdout.write("{}")
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handleHookEvent(eventName: string | undefined): Promise<void> {
  if (!eventName) {
    console.error("Usage: claude-monitor hook <event-name>")
    process.exit(1)
  }

  const payload = await readStdin() as Record<string, unknown>

  switch (eventName.toLowerCase()) {
    case "session-start":
    case "sessionstart":
      await onSessionStart(payload)
      break
    case "session-stop":
    case "stop":
      await onSessionStop(payload)
      break
    case "pre-tool-use":
    case "pretooluse":
      await onPreToolUse(payload)
      break
    case "post-tool-use":
    case "posttooluse":
      await onPostToolUse(payload)
      break
    case "user-prompt-submit":
    case "userpromptsubmit":
      await onUserPromptSubmit(payload)
      break
    default:
      console.error(`[claude-monitor] unknown hook event: ${eventName}`)
      process.exit(1)
  }
}
