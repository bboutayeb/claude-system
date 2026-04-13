import { existsSync, rmSync, readFileSync } from "fs"
import { spawnSync } from "child_process"
import { MONITOR_DIR, BIN_DIR, PID_FILE, config } from "../config"
import { removeHooks } from "./settings-merge"

export async function uninstall(keepData = false): Promise<void> {
  console.log("Uninstalling claude-monitor...")

  // 1. Remove hooks from ~/.claude/settings.json
  const removed = removeHooks()
  if (removed.length > 0) {
    console.log(`  ✓ Removed hooks from ~/.claude/settings.json: ${removed.join(", ")}`)
  } else {
    console.log("  ✓ No hooks found in ~/.claude/settings.json")
  }

  // 2. Stop the running server
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, "utf8").trim())
      if (!isNaN(pid)) {
        process.kill(pid, "SIGTERM")
        console.log(`  ✓ Stopped server (PID ${pid})`)
      }
    } catch {}
    try { rmSync(PID_FILE) } catch {}
  } else {
    // Try killing by port
    const lsof = spawnSync("lsof", ["-ti", `tcp:${config.port}`], { stdio: "pipe" })
    const pids = lsof.stdout?.toString().trim().split("\n").filter(Boolean) ?? []
    for (const pid of pids) {
      try { process.kill(parseInt(pid), "SIGTERM") } catch {}
    }
    if (pids.length > 0) console.log(`  ✓ Stopped server (port ${config.port})`)
  }

  // 3. Stop container (docker or nerdctl)
  const composePath = `${MONITOR_DIR}/docker-compose.yml`
  if (existsSync(composePath)) {
    const runtime = ["docker", "nerdctl"].find(
      r => spawnSync(r, ["info"], { stdio: "pipe" }).status === 0
    ) ?? "docker"
    const composeArgs = keepData ? ["compose", "stop"] : ["compose", "down", "-v"]
    const result = spawnSync(runtime, composeArgs, {
      cwd: MONITOR_DIR,
      stdio: "inherit",
    })
    if (result.status === 0) {
      console.log(keepData ? "  ✓ PostgreSQL container stopped (data preserved)" : "  ✓ PostgreSQL container removed")
    }
  }

  // 4. Remove ~/.claude-monitor directory
  if (existsSync(MONITOR_DIR)) {
    if (keepData) {
      // Only remove bin and config, keep docker data volumes (already handled above)
      try { rmSync(BIN_DIR, { recursive: true }) } catch {}
      console.log(`  ✓ Removed ${BIN_DIR} (data preserved in Docker volume)`)
    } else {
      rmSync(MONITOR_DIR, { recursive: true, force: true })
      console.log(`  ✓ Removed ${MONITOR_DIR}`)
    }
  }

  console.log("\nUninstall complete.")
  if (keepData) {
    console.log("Data was preserved in the container volume. To remove it: docker volume rm claude-monitor_postgres_data  (or nerdctl volume rm ...)")
  }
}
