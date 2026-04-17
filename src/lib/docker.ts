import { spawnSync } from "child_process"

export function detectContainerRuntime(): string | null {
  for (const candidate of ["docker", "nerdctl"]) {
    const check = spawnSync(candidate, ["info"], { stdio: "pipe", timeout: 2000 })
    if (check.error) continue
    if (check.status === 0) return candidate
  }
  return null
}

export interface ComposeUpOptions {
  pgReadyTimeoutMs?: number
  verbose?: boolean
}

export interface ComposeUpResult {
  ok: boolean
  durationMs: number
  error?: string
}

export async function composeUpAndWait(
  cwd: string,
  runtime: string,
  opts: ComposeUpOptions = {}
): Promise<ComposeUpResult> {
  const start = Date.now()
  const timeoutMs = opts.pgReadyTimeoutMs ?? 30000
  const verbose = opts.verbose ?? false

  const up = spawnSync(runtime, ["compose", "up", "-d"], {
    cwd,
    stdio: verbose ? "inherit" : "pipe",
    timeout: 30000,
  })
  if (up.error || up.status !== 0) {
    const stderr = up.stderr?.toString().trim() ?? ""
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: up.error?.message ?? (stderr || `${runtime} compose up exit ${up.status}`),
    }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    const remaining = Math.max(0, deadline - Date.now())
    const check = spawnSync(
      runtime,
      ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "claude", "-d", "claude_system"],
      { cwd, stdio: "pipe", timeout: Math.min(remaining, 5000) }
    )
    if (check.error) {
      return { ok: false, durationMs: Date.now() - start, error: check.error.message }
    }
    if (check.status === 0) return { ok: true, durationMs: Date.now() - start }
    if (verbose) process.stdout.write(".")
  }

  return {
    ok: false,
    durationMs: Date.now() - start,
    error: `pg_isready did not succeed within ${Math.round(timeoutMs / 1000)}s`,
  }
}
