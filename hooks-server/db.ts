import { Pool } from "pg"

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://claude:claude@localhost:5432/claude_system",
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
