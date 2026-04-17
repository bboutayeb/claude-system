import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "fs"
import { spawnSync } from "child_process"
import { Pool } from "pg"
import { MONITOR_DIR, BIN_DIR, BIN_PATH, CONFIG_PATH, config } from "../config"
import { installHooks, cleanProjectLevelHooks } from "./settings-merge"
import { detectContainerRuntime, composeUpAndWait } from "../lib/docker"

// Embedded at build time
import schemaSQL from "../../infra/db/schema.sql" with { type: "text" }

const DOCKER_COMPOSE_CONTENT = `services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_DB: claude_system
      POSTGRES_USER: claude
      POSTGRES_PASSWORD: claude
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U claude -d claude_system"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
`

export async function install(): Promise<void> {
  console.log("Installing claude-monitor...")

  // 1. Create directories
  mkdirSync(BIN_DIR, { recursive: true })
  console.log(`  ✓ Created ${MONITOR_DIR}`)

  // 2. Copy binary (when running as compiled binary, process.execPath is the binary)
  const selfPath = process.execPath
  if (selfPath !== BIN_PATH && existsSync(selfPath)) {
    copyFileSync(selfPath, BIN_PATH)
    spawnSync("chmod", ["+x", BIN_PATH])
    console.log(`  ✓ Installed binary to ${BIN_PATH}`)
  } else {
    console.log(`  ✓ Binary already at ${BIN_PATH}`)
  }

  // 3. Write default config (don't overwrite existing)
  if (!existsSync(CONFIG_PATH)) {
    const defaultConfig = {
      port: 18766,
      db_url: "postgresql://claude:claude@localhost:5432/claude_system",
      anthropic_api_key: null,
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), "utf8")
    console.log(`  ✓ Created config at ${CONFIG_PATH}`)
  } else {
    console.log(`  ✓ Config already exists at ${CONFIG_PATH}`)
  }

  // 4. Write docker-compose.yml
  const composePath = `${MONITOR_DIR}/docker-compose.yml`
  writeFileSync(composePath, DOCKER_COMPOSE_CONTENT, "utf8")
  console.log(`  ✓ Wrote ${composePath}`)

  // 5. Detect container runtime (docker or nerdctl)
  const runtime = detectContainerRuntime()
  if (!runtime) {
    console.error("\n  ERROR: No container runtime found (tried docker, nerdctl).")
    console.error("  Install Docker or containerd+nerdctl and make sure the daemon is running, then re-run install.")
    process.exit(1)
  }
  console.log(`  ✓ Container runtime: ${runtime}`)

  // 6+7. Start PostgreSQL container and wait until pg_isready
  console.log("  Starting PostgreSQL container...")
  const up = await composeUpAndWait(MONITOR_DIR, runtime, { pgReadyTimeoutMs: 30000, verbose: true })
  if (!up.ok) {
    console.error(`\n  ERROR: PostgreSQL did not become ready (${up.error})`)
    process.exit(1)
  }
  console.log(`\n  ✓ PostgreSQL is ready (${Math.round(up.durationMs / 1000)}s)`)

  // 8. Run schema migrations
  console.log("  Running schema migrations...")
  const pool = new Pool({ connectionString: config.db_url })
  try {
    await pool.query(schemaSQL)
    console.log("  ✓ Schema applied")
  } catch (err: unknown) {
    const error = err as Error
    console.error("  ERROR applying schema:", error.message)
    await pool.end()
    process.exit(1)
  }
  await pool.end()

  // 9. Install global hooks in ~/.claude/settings.json
  console.log("  Merging hooks into ~/.claude/settings.json...")
  const { added, skipped } = installHooks()
  if (added.length > 0) console.log(`  ✓ Added hooks: ${added.join(", ")}`)
  if (skipped.length > 0) console.log(`  ✓ Already present: ${skipped.join(", ")}`)

  // 10. Clean up project-level hooks if we're running from a project dir
  const cwd = process.cwd()
  const cleaned = cleanProjectLevelHooks(cwd)
  if (cleaned) {
    console.log(`  ✓ Removed legacy project-level hooks from ${cwd}/.claude/settings.json`)
  }

  console.log(`
Installation complete!

  Dashboard:   http://127.0.0.1:${config.port}/dashboard
  Config:      ${CONFIG_PATH}
  Logs:        /tmp/claude-monitor.log

Start a new Claude Code session to begin collecting metrics.
`)
}
