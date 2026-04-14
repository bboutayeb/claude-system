import { existsSync, readFileSync } from "fs"
import { homedir } from "os"

export const MONITOR_DIR = `${homedir()}/.claude-monitor`
export const CONFIG_PATH = `${MONITOR_DIR}/config.json`
export const PID_FILE = `${MONITOR_DIR}/monitor.pid`
export const BIN_DIR = `${MONITOR_DIR}/bin`
export const BIN_PATH = `${BIN_DIR}/claude-monitor`

export const VERSION = "0.2.0"

interface Config {
  port: number
  db_url: string
  anthropic_api_key: string | null
  haiku_cost_alert_usd: number | null
}

const DEFAULTS: Config = {
  port: 18766,
  db_url: "postgresql://claude:claude@localhost:5432/claude_system",
  anthropic_api_key: null,
  haiku_cost_alert_usd: null,
}

function loadConfig(): Config {
  let file: Partial<Config> = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    } catch {
      // parse error — fall back to defaults
    }
  }
  return {
    port: (() => { const envPort = process.env.HOOKS_PORT !== undefined ? parseInt(process.env.HOOKS_PORT, 10) : NaN; const p = !isNaN(envPort) ? envPort : file.port ?? DEFAULTS.port; return Math.min(65535, Math.max(1, p)) })(),
    db_url: process.env.DATABASE_URL ?? file.db_url ?? DEFAULTS.db_url,
    anthropic_api_key: process.env.ANTHROPIC_API_KEY ?? file.anthropic_api_key ?? null,
    haiku_cost_alert_usd: file.haiku_cost_alert_usd ?? null,
  }
}

export const config = loadConfig()
export const SERVER_URL = `http://127.0.0.1:${config.port}`
