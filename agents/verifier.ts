import { Pool } from "pg"
import { readFileSync, existsSync } from "fs"
import { execSync } from "child_process"

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://claude:claude@localhost:5432/claude_system",
})

// ─── Acceptance criteria types ───────────────────────────────────────────────

type SqlCountCriteria = { type: "sql_count"; query: string; min: number }
type PatternCriteria  = { type: "pattern";   file: string; regex: string }
type FileExistsCriteria = { type: "file_exists"; path: string }
type NoErrorCriteria  = { type: "no_error";  command: string }
type HeuristicCriteria = { type: "heuristic"; file: string; min_chars: number }

type Criteria =
  | SqlCountCriteria
  | PatternCriteria
  | FileExistsCriteria
  | NoErrorCriteria
  | HeuristicCriteria

interface Task {
  id: number
  description: string
  status: string
  acceptance_criteria: Criteria | null
}

// ─── Verifiers ───────────────────────────────────────────────────────────────

async function verifySqlCount(c: SqlCountCriteria): Promise<boolean> {
  const result = await pool.query(c.query)
  const count = parseInt(result.rows[0]?.count ?? result.rows[0]?.[Object.keys(result.rows[0])[0]] ?? "0", 10)
  return count >= c.min
}

function verifyPattern(c: PatternCriteria): boolean {
  if (!existsSync(c.file)) return false
  const content = readFileSync(c.file, "utf8")
  return new RegExp(c.regex).test(content)
}

function verifyFileExists(c: FileExistsCriteria): boolean {
  return existsSync(c.path)
}

function verifyNoError(c: NoErrorCriteria): boolean {
  try {
    const output = execSync(c.command, { encoding: "utf8", stdio: "pipe" })
    return !/error/i.test(output)
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string }
    const combined = (execErr.stdout ?? "") + (execErr.stderr ?? "")
    return !/error/i.test(combined)
  }
}

function verifyHeuristic(c: HeuristicCriteria): boolean {
  if (!existsSync(c.file)) return false
  const content = readFileSync(c.file, "utf8")
  return content.length >= c.min_chars
}

async function verifyCriteria(criteria: Criteria): Promise<boolean> {
  switch (criteria.type) {
    case "sql_count":   return verifySqlCount(criteria)
    case "pattern":     return verifyPattern(criteria)
    case "file_exists": return verifyFileExists(criteria)
    case "no_error":    return verifyNoError(criteria)
    case "heuristic":   return verifyHeuristic(criteria)
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runAll() {
  const { rows: tasks } = await pool.query<Task>(
    "SELECT id, description, status, acceptance_criteria FROM tasks WHERE status = 'pending_review' ORDER BY id LIMIT 50"
  )

  if (tasks.length === 0) {
    console.log("No tasks in pending_review state.")
    await pool.end()
    return
  }

  let passed = 0
  let failed = 0

  for (const task of tasks) {
    const criteria = task.acceptance_criteria
    if (!criteria) {
      console.log(`  [SKIP] #${task.id} — no acceptance_criteria`)
      continue
    }

    let ok = false
    try {
      ok = await verifyCriteria(criteria)
    } catch (err: unknown) {
      const error = err as Error
      console.error(`  [ERROR] #${task.id} — ${error.message}`)
    }

    const newStatus = ok ? "verified" : "failed"
    await pool.query(
      "UPDATE tasks SET status = $1, verified_at = now() WHERE id = $2",
      [newStatus, task.id]
    )

    const icon = ok ? "✓" : "✗"
    console.log(`  [${icon}] #${task.id} ${newStatus.padEnd(8)} — ${task.description}`)
    ok ? passed++ : failed++
  }

  console.log(`\n${passed + failed} tasks verified: ${passed} passed, ${failed} failed`)
  await pool.end()
}

runAll().catch((err) => {
  console.error("[verifier] fatal:", err.message)
  process.exit(1)
})
