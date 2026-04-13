// claude-monitor CLI entry point
// Usage: claude-monitor <command> [args...]

import { config, SERVER_URL, VERSION } from "./config"

const cmd = process.argv[2]
const args = process.argv.slice(3)

switch (cmd) {
  case "server": {
    const { startServer } = await import("./server")
    startServer()
    break
  }

  case "hook": {
    const { handleHookEvent } = await import("./hooks/handler")
    await handleHookEvent(args[0])
    break
  }

  case "verify": {
    // Agents are standalone scripts — import triggers execution
    await import("./agents/verifier")
    break
  }

  case "score": {
    await import("./agents/quality-scorer")
    break
  }

  case "install": {
    const { install } = await import("./install/install")
    await install()
    break
  }

  case "uninstall": {
    const keepData = args.includes("--keep-data")
    const { uninstall } = await import("./install/uninstall")
    await uninstall(keepData)
    break
  }

  case "status": {
    try {
      const res = await fetch(`${SERVER_URL}/status`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const status = await res.json() as { ok: boolean; apiKey: boolean }
        console.log(`Server: running on port ${config.port}`)
        console.log(`API key: ${status.apiKey ? "present" : "not configured"}`)
        console.log(`Dashboard: http://localhost:${config.port}/dashboard`)
      } else {
        console.log("Server: not responding")
      }
    } catch {
      console.log("Server: not running")
      console.log(`Start with: claude-monitor server`)
    }
    break
  }

  case "version":
  case "--version":
  case "-v": {
    console.log(VERSION)
    break
  }

  default: {
    console.log(`claude-monitor v${VERSION}

Usage: claude-monitor <command>

Commands:
  install          Install hooks and start PostgreSQL
  uninstall        Remove hooks and stop services
                   --keep-data  preserve database
  server           Start the HTTP server (foreground)
  hook <event>     Handle a Claude Code hook event (reads stdin)
  status           Show server health and config
  verify           Run task acceptance verifier
  score            Run prompt quality scorer
  version          Print version
`)
    if (cmd && cmd !== "help" && cmd !== "--help") process.exit(1)
    break
  }
}
