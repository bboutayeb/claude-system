# Plan : Système agentique IA solide et mesurable
 
## Contexte
 
L'objectif est de construire, depuis zéro, un système agentique autour de Claude Code qui soit :
- **mesurable** (tokens, latence, qualité des réponses)
- **optimisable** (leviers concrets à chaque étape)
- **fiable** (guardrails, vérification externe)
 
Sources d'inspiration : blog de Mathieu Grenier (hooks, token optimization, observability, RTK, prompt caching, guardrails, registre markdown) + Claude Conductor (session chaining).
 
### Environnement existant
- `/home/user/repo/` — dépôt git vide (`claude-system`)
- `~/.claude/settings.json` — Stop hook git-check configuré (script `~/.claude/stop-hook-git-check.sh` existant et enregistré dans settings.json)
- Outils disponibles : `jq`, `rg`, `yq`, `psql` (host), `bun`, `node`
- `mise` (mise-en-place) : gestionnaire de runtimes — utilisé pour isoler Node/Bun dans le repo
- PostgreSQL : via **Docker Compose** (version stable récente), pas le psql host
- Pas d'Ollama local → remplacé par Claude Haiku (API) pour les tâches légères
 
### Principes de configuration
- **Local d'abord** : tout va dans `repo/.claude/` avant d'envisager `~/.claude/`
- **CLAUDE.md dans le repo** avant d'envisager un global
- Phase 5 (multi-sessions) reportée après validation des phases 1-4
 
---
 
## Architecture cible
 
```
┌─────────────────────────────────────────────────────────────┐
│                     SESSION CLAUDE CODE                     │
│                                                             │
│  [PreToolUse hook] ──→ HTTP Server :18766 ──→ [PostToolUse] │
│         ↓                    ↓                    ↓         │
│   prompt enrichment    token tracking        output filter  │
└───────────────────────────┬─────────────────────────────────┘
                            │ fire-and-forget HTTP
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                     COUCHE PERSISTANCE                      │
│                                                             │
│  PostgreSQL (Docker Compose)                                │
│  ├── sessions (id, start, tokens_in, tokens_out, cache)    │
│  ├── tool_calls (session_id, tool, duration_ms, tokens)     │
│  ├── kpi_snapshots (daily aggregates)                       │
│  └── tasks (id, status, acceptance_criteria)                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                  COUCHE VISUALISATION                       │
│  REST API :8765 → métriques (tokens, latence,              │
│  cache_hit_rate, waste_rate, tool_call_count)               │
└─────────────────────────────────────────────────────────────┘
```
 
---
 
## Levier immédiat — À faire maintenant (avant de relancer la session)
 
Ces deux actions ont un effet mesurable dès la prochaine session, **sans infrastructure** :
 
### A. Créer `repo/CLAUDE.md` avec les règles token
 
```markdown
## Token Optimization Rules
- ALWAYS: use `rg` instead of grep
- ALWAYS: grep/rg before Read — never read a full file to find one value
- ALWAYS: pipe bash output through `head -50` or `| jq .field`
- ALWAYS: use `jq` to extract JSON fields (95% token reduction vs full output)
- ALWAYS: add `LIMIT 50` to SQL queries unless explicitly counting
- NEVER: read a file entirely when offset/limit suffice
- COMPACT: run /compact when context exceeds 50%
- GIT: always `git log --oneline -20`
```
 
### B. Créer `repo/.claude/settings.json` (hooks locaux)
 
```json
{
  "hooks": {
    "SessionStart": [],
    "PreToolUse": [],
    "PostToolUse": []
  }
}
```
 
Vide pour l'instant — sera rempli au fur et à mesure des phases.
 
---
 
## Phase 1 — Fondations : Observabilité (mesurer avant d'optimiser)
 
**Pourquoi en premier** : Sans mesure, aucune optimisation n'est vérifiable.
 
### 1.1 Docker Compose PostgreSQL
 
Fichier : `repo/docker-compose.yml`
 
```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_DB: claude_system
      POSTGRES_USER: claude
      POSTGRES_PASSWORD: claude
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./infra/db:/docker-entrypoint-initdb.d
 
volumes:
  postgres_data:
```
 
### 1.2 Schéma PostgreSQL
 
Fichier : `repo/infra/db/001_schema.sql`
 
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0
);
 
CREATE TABLE tool_calls (
  id SERIAL PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  tool_name TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER DEFAULT 0,
  called_at TIMESTAMPTZ DEFAULT now()
);
 
CREATE TABLE kpi_snapshots (
  snapshot_date DATE PRIMARY KEY,
  total_sessions INTEGER,
  avg_input_tokens NUMERIC,
  cache_hit_rate NUMERIC,
  waste_rate NUMERIC
);
```
 
### 1.3 Gestionnaire de runtimes avec mise
 
Fichier : `repo/.mise.toml`
 
```toml
[tools]
node = "22"
bun = "latest"
```
 
Commande d'initialisation : `mise install` dans `repo/`
 
### 1.4 Serveur HTTP de hooks (Bun)
 
**Problème** : chaque hook `command` lance un nouveau process Bun (~230ms cold start). Avec 50 tool calls/session → 11 secondes de latence accumulée.
 
**Solution** : un seul serveur HTTP persistant lancé au `SessionStart`, tous les hooks deviennent des requêtes HTTP (~0.3ms).
 
Fichier : `repo/hooks-server/server.ts`
 
```
Routes :
  POST /health         → 200 OK
  POST /session/start  → INSERT INTO sessions
  POST /session/stop   → UPDATE sessions SET ended_at
  POST /pre-tool       → (phase 3) détection ambiguïté
  POST /post-tool      → INSERT INTO tool_calls
```
 
Fichier : `repo/hooks/session-start.sh`
```bash
#!/bin/bash
# Lance le serveur si pas déjà actif
if ! curl -sf http://127.0.0.1:18766/health > /dev/null 2>&1; then
  cd /home/user/repo
  mise exec -- bun run hooks-server/server.ts &
  sleep 0.5
fi
# Notifier démarrage de session
SESSION_ID=$(echo "$1" | jq -r '.session_id // "unknown"')
curl -sf -X POST http://127.0.0.1:18766/session/start \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\": \"$SESSION_ID\"}" || true
```
 
### 1.5 Enregistrement dans `repo/.claude/settings.json`
 
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{"type": "command", "command": "/home/user/repo/hooks/session-start.sh"}]
    }],
    "PreToolUse": [{
      "hooks": [{"type": "command", "command": "curl -sf -X POST http://127.0.0.1:18766/pre-tool -d @- -H 'Content-Type: application/json' || true"}]
    }],
    "PostToolUse": [{
      "hooks": [{"type": "command", "command": "curl -sf -X POST http://127.0.0.1:18766/post-tool -d @- -H 'Content-Type: application/json' || true"}]
    }]
  }
}
```
 
**Vérification Phase 1** :
```bash
cd repo && docker compose up -d
mise install
# Lancer une session Claude Code dans repo/
# Puis :
psql -h localhost -U claude claude_system -c "SELECT * FROM sessions ORDER BY started_at DESC LIMIT 5;"
psql -h localhost -U claude claude_system -c "SELECT tool_name, COUNT(*), AVG(duration_ms) FROM tool_calls GROUP BY tool_name;"
```
 
---
 
## Phase 2 — Prompt Caching
 
**Règle critique** : les blocs système doivent dépasser **1024 tokens** pour que le cache s'active (sinon `cache_read_input_tokens: 0` silencieusement).
 
Structure pour toute intégration API :
1. Layer 1 (stable, > 1024 tokens) : règles globales + contexte projet → marqué `cache_control: {"type": "ephemeral"}`
2. Layer 2 (semi-stable) : contexte agent spécifique → marqué `cache_control`
3. Layer 3 (dynamique) : résultats RAG + message utilisateur → pas de cache
 
**Dans `repo/CLAUDE.md`** : ajouter une section de contexte projet suffisamment longue pour dépasser 1024 tokens dans le system prompt.
 
**Vérification Phase 2** :
```bash
# Après quelques sessions :
psql -h localhost -U claude claude_system \
  -c "SELECT AVG(cache_read_tokens::float / NULLIF(input_tokens,0)) as cache_hit_rate FROM sessions WHERE started_at > now() - interval '1 day';"
# Objectif : cache_hit_rate > 0 (était 0 avant)
```
 
---
 
## Phase 3 — Enrichissement de prompts (Claude Haiku)
 
**Remplacement d'Ollama par Claude Haiku** (10x moins cher que Sonnet, ~300ms).
 
### 3.1 Hook PreToolUse — Détection de prompts ambigus
 
Fichier : `repo/hooks-server/routes/pre-tool.ts`
 
```typescript
const AMBIGUITY_TRIGGERS = [
  /\b(this|that|it|them|those|these)\b/i,
  /\b(redo|undo|revert|retry)\b/i,
  /\bthe (recommendations?|suggestions?|changes?)\b/i
];
 
function isAmbiguous(prompt: string): boolean {
  return prompt.length < 30 || AMBIGUITY_TRIGGERS.some(r => r.test(prompt));
}
// Si ambiguïté → appel Haiku → suggestion affichée dans terminal
// Le hook ne bloque pas — il suggère uniquement
```
 
**Vérification Phase 3** :
- Soumettre "fix it" → voir la suggestion s'afficher en < 500ms
- Vérifier `duration_ms` dans `tool_calls` pour la route pre-tool
 
---
 
## Phase 4 — Fiabilité : Guardrails et vérification
 
### 4.1 Table de tâches avec critères d'acceptation
 
Fichier : `repo/infra/db/002_tasks.sql`
 
```sql
CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','done','pending_review','verified','failed')),
  acceptance_criteria JSONB,
  -- ex: {"type": "sql_count", "query": "SELECT COUNT(*) FROM X", "min": 5}
  -- ex: {"type": "file_exists", "path": "dist/index.js"}
  -- ex: {"type": "pattern", "file": "src/app.ts", "regex": "export default"}
  created_at TIMESTAMPTZ DEFAULT now(),
  verified_at TIMESTAMPTZ
);
 
-- Transition automatique : done → pending_review si acceptance_criteria présent
CREATE OR REPLACE FUNCTION auto_pending_review() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'done' AND NEW.acceptance_criteria IS NOT NULL THEN
    NEW.status = 'pending_review';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
 
CREATE TRIGGER task_status_guard
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION auto_pending_review();
```
 
### 4.2 Script de vérification automatique
 
Fichier : `repo/agents/verifier.ts`
 
5 types (sans appel LLM) :
- `sql_count` : `SELECT COUNT(*) > N`
- `pattern` : regex sur un fichier
- `file_exists` : présence de fichier
- `no_error` : absence de "error" dans un output
- `heuristic` : longueur contenu > N chars
 
**Vérification Phase 4** :
```bash
mise exec -- bun run repo/agents/verifier.ts --run-all
# Sortie attendue : X/Y tasks verified, Z failures
```
 
---
 
## Ordre d'implémentation (rapide → complexe)
 
```
MAINTENANT (avant relancer la session)
  └── Levier immédiat A+B : CLAUDE.md + settings.json vide    [15 min]
 
Phase 1 — Observabilité
  ├── docker-compose.yml + schema.sql                          [1h]
  ├── .mise.toml + mise install                                [15 min]
  ├── hooks-server/server.ts (Bun HTTP)                        [2-3h]
  └── hooks/session-start.sh + settings.json local             [30 min]
 
Phase 2 — Prompt Caching
  └── Enrichir CLAUDE.md + structure API caching              [1h]
 
Phase 3 — Enrichissement prompts (Haiku)
  └── pre-tool route + détection ambiguïté                    [2h]
 
Phase 4 — Guardrails
  ├── 002_tasks.sql + triggers                                  [1h]
  └── agents/verifier.ts                                        [2h]
 
Phase 5 — Multi-sessions (plus tard, après validation 1-4)
```
 
## Arborescence cible `repo/`
 
```
repo/
├── CLAUDE.md                          # Règles token + contexte projet
├── docker-compose.yml                 # PostgreSQL 17
├── .mise.toml                         # node=22, bun=latest
├── .claude/
│   └── settings.json                  # Hooks locaux (SessionStart, Pre/PostToolUse)
├── infra/
│   └── db/
│       ├── 001_schema.sql             # sessions, tool_calls, kpi_snapshots
│       └── 002_tasks.sql              # tasks + triggers (Phase 4)
├── hooks/
│   └── session-start.sh               # Lance le serveur HTTP Bun
├── hooks-server/
│   ├── server.ts                      # Serveur Bun HTTP :18766
│   └── routes/
│       ├── pre-tool.ts                # Phase 3 : détection ambiguïté
│       ├── post-tool.ts               # Token tracking
│       └── session.ts                 # Start/stop session
└── agents/
    └── verifier.ts                    # Phase 4 : vérification critères
```
