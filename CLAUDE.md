# Claude System — Agent Configuration

## Token Optimization Rules

- ALWAYS: use `rg` instead of grep
- ALWAYS: rg/Grep before Read — never read a full file to find one value
- ALWAYS: pipe bash output through `head -50` or `| jq .field`
- ALWAYS: use `jq` to extract JSON fields (95% token reduction vs full output)
- ALWAYS: add `LIMIT 50` to SQL queries unless explicitly counting
- NEVER: read a file entirely when offset/limit suffice
- COMPACT: run /compact when context exceeds 50%
- GIT: always `git log --oneline -20`

## Project Context

This repository implements a measurable, optimizable, and reliable agentic system
built around Claude Code. Distributed as a single compiled binary (`claude-monitor`).

### Architecture

- **CLI binary** (`src/cli.ts`) — compiled with `bun build --compile`, entry point for all sub-commands
- **HTTP server** (`src/server.ts`) — persistent server on port 18766, receives hook events and serves the dashboard
  - Auto-started by the `SessionStart` hook if not already running
  - Persists token usage, tool calls, prompts to PostgreSQL
  - Detects ambiguous prompts and suggests clarifications
- **Hook handler** (`src/hooks/handler.ts`) — replaces the 4 legacy shell scripts
- **Agents** (`src/agents/`) — `verifier.ts` (acceptance criteria), `quality-scorer.ts` (prompt scoring via Haiku)
- **PostgreSQL** (`infra/docker-compose.yml`) — observability data store
  - `sessions`, `tool_calls`, `kpi_snapshots`, `prompts` tables
- **Install/uninstall** (`src/install/`) — Docker PG setup + atomic settings-merge into `~/.claude/settings.json`

### Key design decisions

1. Single persistent HTTP server (not per-invocation shell scripts) to avoid ~230ms cold-start per tool call.
2. Fire-and-forget HTTP from hooks — hooks never block Claude Code's execution.
3. PostgreSQL via Docker Compose — no host-level DB dependency.
4. Compiled binary — no runtime dependency (Bun, Node, mise) on target machines.
5. Claude Haiku for lightweight LLM tasks (ambiguity detection, quality scoring).

### Stack

- HTTP server: Bun + TypeScript
- Database: PostgreSQL 17 (Docker Compose)
- Build: `bun build --compile` → linux-x64, darwin-arm64, darwin-x64
- Claude API: Anthropic SDK (prompt caching enabled)

### Environment

- Repo: `/home/zaibaker/Code/Perso/IA/prompt`
- Server: `http://127.0.0.1:18766`
- PostgreSQL: `localhost:5432`, db=`claude_system`, user=`claude`
- Dev server: `bun run src/cli.ts server`
- Config: `~/.claude-monitor/config.json`

## SQL Conventions

- Always `LIMIT 50` unless counting
- Use `EXPLAIN ANALYZE` before optimizing queries
- Connection string: `postgresql://claude:claude@localhost:5432/claude_system`
- **Migrations** : toute migration dans `infra/db/migrations/` doit aussi mettre à jour `infra/db/schema.sql` (état final). `schema.sql` est la seule source de vérité pour les fresh installs.

## File Conventions

- TypeScript: no semicolons, 2-space indent, ESM imports
- Shell scripts: `#!/bin/bash`, `set -euo pipefail` unless fire-and-forget
- SQL: uppercase keywords, lowercase identifiers
