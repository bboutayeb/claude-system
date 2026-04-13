// Safe merge of claude-monitor hooks into ~/.claude/settings.json.
// Never touches other settings (permissions, model, etc.).
// Uses atomic write (tmp → rename) to prevent corruption.

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync } from "fs"
import { homedir } from "os"
import { BIN_PATH } from "../config"

const CLAUDE_SETTINGS = `${homedir()}/.claude/settings.json`
const CLAUDE_SETTINGS_BAK = `${homedir()}/.claude/settings.json.bak`
const CLAUDE_SETTINGS_TMP = `${homedir()}/.claude/settings.json.tmp`
const MARKER = "claude-monitor"

// Claude Code hook event names → handler subcommand name
const HOOK_EVENTS: Record<string, string> = {
  SessionStart: "session-start",
  Stop: "session-stop",
  PreToolUse: "pre-tool-use",
  PostToolUse: "post-tool-use",
  UserPromptSubmit: "user-prompt-submit",
}

type HookEntry = { type: string; command: string }
type HookGroup = { hooks: HookEntry[]; matcher?: unknown }
type Settings = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown }

function readSettings(): Settings {
  if (!existsSync(CLAUDE_SETTINGS)) return {}
  try {
    return JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"))
  } catch {
    return {}
  }
}

function hasMonitorHook(groups: HookGroup[]): boolean {
  return groups.some(g =>
    g.hooks?.some(h => h.command?.includes(MARKER))
  )
}

export function installHooks(): { added: string[]; skipped: string[] } {
  const settings = readSettings()
  settings.hooks ??= {}

  const added: string[] = []
  const skipped: string[] = []

  for (const [event, subcommand] of Object.entries(HOOK_EVENTS)) {
    settings.hooks[event] ??= []
    const groups = settings.hooks[event]

    if (hasMonitorHook(groups)) {
      skipped.push(event)
      continue
    }

    groups.push({
      hooks: [{
        type: "command",
        command: `${BIN_PATH} hook ${subcommand}`,
      }],
    })
    added.push(event)
  }

  writeSettingsAtomic(settings)
  return { added, skipped }
}

export function removeHooks(): string[] {
  if (!existsSync(CLAUDE_SETTINGS)) return []
  const settings = readSettings()
  if (!settings.hooks) return []

  const removed: string[] = []

  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length
    settings.hooks[event] = settings.hooks[event].filter(
      g => !g.hooks?.some(h => h.command?.includes(MARKER))
    )
    if (settings.hooks[event].length < before) removed.push(event)
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks

  writeSettingsAtomic(settings)
  return removed
}

function writeSettingsAtomic(settings: Settings): void {
  // Ensure directory exists
  mkdirSync(`${homedir()}/.claude`, { recursive: true })

  const json = JSON.stringify(settings, null, 2)

  // Validate before writing
  JSON.parse(json)

  // Backup current file
  if (existsSync(CLAUDE_SETTINGS)) {
    copyFileSync(CLAUDE_SETTINGS, CLAUDE_SETTINGS_BAK)
  }

  // Write to tmp, then atomically rename
  writeFileSync(CLAUDE_SETTINGS_TMP, json, "utf8")
  renameSync(CLAUDE_SETTINGS_TMP, CLAUDE_SETTINGS)
}

// Remove claude-monitor hooks from a project-level .claude/settings.json
// Called during install when the user has old per-project hooks.
export function cleanProjectLevelHooks(projectDir: string): boolean {
  const projectSettings = `${projectDir}/.claude/settings.json`
  if (!existsSync(projectSettings)) return false

  let settings: Settings
  try {
    settings = JSON.parse(readFileSync(projectSettings, "utf8"))
  } catch {
    return false
  }

  if (!settings.hooks) return false

  let hadMonitorHooks = false
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length
    settings.hooks[event] = settings.hooks[event].filter(
      g => !g.hooks?.some(h =>
        h.command?.includes(MARKER) ||
        // Legacy: shell scripts with absolute paths
        h.command?.match(/\/hooks\/(session-start|session-stop|pre-tool-use|user-prompt-submit)\.sh$/)
      )
    )
    if (settings.hooks[event].length < before) hadMonitorHooks = true
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }

  if (!hadMonitorHooks) return false

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks

  const json = JSON.stringify(settings, null, 2)
  const tmp = `${projectDir}/.claude/settings.json.tmp`
  writeFileSync(tmp, json, "utf8")
  renameSync(tmp, projectSettings)
  return true
}
