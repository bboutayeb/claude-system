import { writeFileSync } from "fs"
import { handleSessionStart, handleSessionStop } from "./routes/session"
import { handlePostTool } from "./routes/post-tool"
import { handlePreTool } from "./routes/pre-tool"
import { handleUserPrompt, loadAllowlist } from "./routes/user-prompt"
import { handleDashboardKpis, handleDashboardTools, handleDashboardPrompts, handleDashboardSessions, handleDashboardHaikuCost, handleTranscript } from "./routes/dashboard"
import { handleAmbiguityList, handleAmbiguityFeedback } from "./routes/ambiguity"
import { config, PID_FILE } from "./config"

// Embedded at build time — Bun resolves this relative to src/
import dashboardHtml from "../public/dashboard.html" with { type: "text" }

async function parseBody(req: Request): Promise<unknown> {
  const text = await req.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export function startServer() {
  const hasApiKey = Boolean(config.anthropic_api_key)

  const server = Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url)

      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("ok")
      }

      if (req.method === "GET" && url.pathname === "/status") {
        return new Response(JSON.stringify({ ok: true, apiKey: hasApiKey }), {
          headers: { "Content-Type": "application/json" },
        })
      }

      if (req.method === "GET" && url.pathname.startsWith("/dashboard")) {
        if (url.pathname === "/dashboard") {
          return new Response(dashboardHtml, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
        }
        switch (url.pathname) {
          case "/dashboard/kpis":
            return handleDashboardKpis(url)
          case "/dashboard/tools":
            return handleDashboardTools(url)
          case "/dashboard/prompts":
            return handleDashboardPrompts(url)
          case "/dashboard/sessions":
            return handleDashboardSessions(url)
          case "/dashboard/haiku-cost":
            return handleDashboardHaikuCost(url)
          case "/dashboard/ambiguities":
            return handleAmbiguityList(url)
          default:
            return new Response("not found", { status: 404 })
        }
      }

      if (req.method === "GET" && url.pathname === "/transcript") {
        return handleTranscript(url)
      }

      if (req.method !== "POST") {
        return new Response("not found", { status: 404 })
      }

      const body = await parseBody(req)

      switch (url.pathname) {
        case "/session/start":
          return handleSessionStart(body)
        case "/session/stop":
          return handleSessionStop(body)
        case "/user-prompt":
          return handleUserPrompt(body)
        case "/pre-tool":
          return handlePreTool(body)
        case "/post-tool":
          return handlePostTool(body)
        case "/ambiguity/feedback":
          return handleAmbiguityFeedback(body)
        default:
          return new Response("not found", { status: 404 })
      }
    },
    error(err) {
      console.error("[server] error:", err)
      return new Response("internal error", { status: 500 })
    },
  })

  try { writeFileSync(PID_FILE, String(process.pid), "utf8") } catch {}

  console.log(`[claude-monitor] server listening on http://127.0.0.1:${config.port}`)
  console.log(`[claude-monitor] ANTHROPIC_API_KEY: ${hasApiKey ? "present" : "not set — Haiku features disabled"}`)
  console.log(`[claude-monitor] dashboard: http://127.0.0.1:${config.port}/dashboard`)

  // Load false-positive allowlist from DB at startup
  loadAllowlist().catch(() => {})

  return server
}
