import { Client } from "pg"

const client = new Client({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://claude:claude@localhost:5432/claude_system",
})

let connected = false

async function ensureConnected() {
  if (!connected) {
    await client.connect()
    connected = true
  }
}

export const db = {
  async query(text: string, values?: unknown[]) {
    await ensureConnected()
    return client.query(text, values)
  },
}
