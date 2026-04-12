import { handleSessionStart, handleSessionStop } from "./routes/session"
import { handlePostTool } from "./routes/post-tool"
import { handlePreTool } from "./routes/pre-tool"

const PORT = parseInt(process.env.HOOKS_PORT ?? "18766")

async function parseBody(req: Request): Promise<unknown> {
  const text = await req.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("ok")
    }

    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 })
    }

    const body = await parseBody(req)

    switch (url.pathname) {
      case "/health":
        return new Response("ok")
      case "/session/start":
        return handleSessionStart(body)
      case "/session/stop":
        return handleSessionStop(body)
      case "/pre-tool":
        return handlePreTool(body)
      case "/post-tool":
        return handlePostTool(body)
      default:
        return new Response("not found", { status: 404 })
    }
  },
  error(err) {
    console.error("[server] error:", err)
    return new Response("internal error", { status: 500 })
  },
})

console.log(`[hooks-server] listening on http://127.0.0.1:${PORT}`)
