import { Pool } from "pg"
import { config } from "./config"

const pool = new Pool({
  connectionString: config.db_url,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

pool.on("error", (err) => {
  console.error("[db] pool error:", err.message)
})

export const db = {
  async query(text: string, values?: unknown[]) {
    return pool.query(text, values)
  },
}
