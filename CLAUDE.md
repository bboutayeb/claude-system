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
built around Claude Code. It is structured as follows:

### Architecture

- **Hooks server** (`hooks-server/`) — persistent Bun HTTP server on port 18766
  - Receives PreToolUse / PostToolUse / SessionStart events via HTTP
  - Persists token usage and tool call metrics to PostgreSQL
  - Detects ambiguous prompts (Phase 3) and suggests clarifications
- **PostgreSQL** (`docker-compose.yml`) — observability data store
  - `sessions` table: input/output/cache tokens per session
  - `tool_calls` table: per-tool latency and token usage
  - `kpi_snapshots` table: daily aggregates for trend analysis
  - `tasks` table: acceptance criteria + automated verification (Phase 4)
- **Hooks** (`hooks/`) — shell scripts wiring Claude Code lifecycle to the HTTP server
- **Agents** (`agents/`) — automated verifier for task acceptance criteria (Phase 4)

### Key design decisions

1. Single persistent HTTP server (not per-invocation shell scripts) to avoid ~230ms
   cold-start cost per tool call.
2. Fire-and-forget HTTP from hooks — hooks never block Claude Code's execution.
3. PostgreSQL via Docker Compose — no host-level DB dependency.
4. `mise` for runtime isolation — Node 22 and Bun managed locally in the repo.
5. Claude Haiku (not Ollama) for lightweight LLM tasks (ambiguity detection).

### Stack

- Runtime management: `mise` (`.mise.toml`)
- HTTP server: Bun + TypeScript
- Database: PostgreSQL 17 (Docker Compose)
- Claude API: Anthropic SDK (prompt caching enabled)

### Environment

- Repo: `/home/zaibaker/Code/Perso/IA/prompt`
- Hooks server: `http://127.0.0.1:18766`
- PostgreSQL: `localhost:5432`, db=`claude_system`, user=`claude`
- Hooks server start: `cd /home/zaibaker/Code/Perso/IA/prompt && mise exec -- bun run hooks-server/server.ts`

## SQL Conventions

- Always `LIMIT 50` unless counting
- Use `EXPLAIN ANALYZE` before optimizing queries
- Connection string: `postgresql://claude:claude@localhost:5432/claude_system`

## File Conventions

- TypeScript: no semicolons, 2-space indent, ESM imports
- Shell scripts: `#!/bin/bash`, `set -euo pipefail` unless fire-and-forget
- SQL: uppercase keywords, lowercase identifiers
