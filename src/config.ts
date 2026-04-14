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
  realtime_scoring: boolean
  realtime_scoring_throttle_s: number
}

const DEFAULTS: Config = {
  port: 18766,
  db_url: "postgresql://claude:claude@localhost:5432/claude_system",
  anthropic_api_key: null,
  haiku_cost_alert_usd: null,
  realtime_scoring: true,
  realtime_scoring_throttle_s: 30,
}

function parsePort(envVal: string | undefined, fileVal: number | undefined): number {
  const envPort = envVal !== undefined ? parseInt(envVal, 10) : NaN
  const p = !isNaN(envPort) ? envPort : fileVal ?? DEFAULTS.port
  return Math.min(65535, Math.max(1, p))
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
    port: parsePort(process.env.HOOKS_PORT, file.port),
    db_url: process.env.DATABASE_URL ?? file.db_url ?? DEFAULTS.db_url,
    anthropic_api_key: process.env.ANTHROPIC_API_KEY ?? file.anthropic_api_key ?? null,
    haiku_cost_alert_usd: file.haiku_cost_alert_usd ?? null,
    realtime_scoring: file.realtime_scoring ?? DEFAULTS.realtime_scoring,
    realtime_scoring_throttle_s: Math.max(1, file.realtime_scoring_throttle_s ?? DEFAULTS.realtime_scoring_throttle_s),
  }
}

export const config = loadConfig()
export const SERVER_URL = `http://127.0.0.1:${config.port}`
