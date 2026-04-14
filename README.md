# claude-monitor

Système d'observabilité pour Claude Code — collecte tokens, latence, qualité des prompts
et KPIs via hooks, sans dépendance de runtime. Distribué comme un binaire compilé unique.

> Inspiré des travaux de **Mathieu Grenier** ([mathieugrenier.fr](https://mathieugrenier.fr)),
> qui a documenté et mesuré ces patterns en production sur 11 articles (janvier–avril 2026) :
> hooks Bun persistants, token optimization, prompt caching, observabilité LLM, RTK, guardrails.

---

## Ce que ça fait

- **Collecte silencieuse** : 5 hooks Claude Code (SessionStart, Stop, PreToolUse, PostToolUse,
  UserPromptSubmit) → requêtes HTTP vers un serveur Bun persistant. Les 4 premiers hooks sont
  fire-and-forget (timeout borné). `UserPromptSubmit` attend la réponse pour écrire sur stdout
  (détection d'ambiguïté synchrone).
- **Latence négligeable** : ~0,2 ms par hook HTTP (un process Bun démarré à froid coûte ~230 ms — le serveur persistant évite ce coût à chaque appel)
- **Tokens & coût** : input/output/cache agrégés par session depuis les transcripts JSONL
- **Durée des outils** : chronomètre in-memory PreToolUse → PostToolUse
- **Détection d'ambiguïté** : prompts courts ou déictiques → clarification via Claude Haiku
- **Quality scoring** : score 1–10 par paire prompt↔réponse (Haiku, post-session)
- **Guardrails** : table `tasks` avec critères d'acceptation + vérificateur automatique
- **Dashboard** : coût USD, cache hit rate, ambiguity rate, top outils — `http://localhost:18766/dashboard`

---

## Architecture

```
Claude Code session
  │
  ├─ SessionStart      ──→ claude-monitor hook session-start
  ├─ UserPromptSubmit  ──→ claude-monitor hook user-prompt-submit
  ├─ PreToolUse        ──→ claude-monitor hook pre-tool-use
  ├─ PostToolUse       ──→ claude-monitor hook post-tool-use
  └─ Stop              ──→ claude-monitor hook session-stop
           │
           │  fire-and-forget HTTP (< 1 ms)
           ▼
  HTTP Server :18766  (Bun, auto-démarré au SessionStart)
           │
           ├─ /session/start|stop  →  sessions table
           ├─ /user-prompt         →  ambiguity detection + prompts table
           ├─ /pre-tool            →  timer start (in-memory Map)
           ├─ /post-tool           →  tool_calls (duration_ms calculé)
           └─ /dashboard/*         →  dashboard HTML + JSON API
                    │
                    ▼
           PostgreSQL :5432  (Docker Compose)
           ├── sessions        — tokens, cache, model, transcript_path
           ├── tool_calls      — duration_ms, outil, session
           ├── prompts         — is_ambiguous, quality_score, char_length
           ├── ambiguities     — suggestions générées par Haiku
           ├── tasks           — critères d'acceptation + statut
           └── kpi_snapshots   — agrégats journaliers (trigger auto)
```

---

## Installation

```bash
curl -fsSL https://github.com/bboutayeb/claude-system/releases/latest/download/install.sh | bash
```

L'installateur :
1. Détecte l'OS / l'architecture (Linux x64, macOS arm64/x64)
2. Télécharge le binaire dans `~/.claude-monitor/bin/`
3. Démarre un container Docker PostgreSQL et applique le schéma
4. Injecte les 5 hooks dans `~/.claude/settings.json`

> **Prérequis** : [Docker](https://docs.docker.com/get-docker/) et `ANTHROPIC_API_KEY` dans l'environnement.
> **WSL2** : utiliser `localhost` (pas `127.0.0.1`) dans le navigateur Windows pour le dashboard.

Ajouter le binaire au PATH (une seule fois, exemple pour bash — adapter selon ton shell) :
```bash
echo 'export PATH="$HOME/.claude-monitor/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

---

## Utilisation

```bash
claude-monitor install          # (Re)installe Docker PG + hooks globaux
claude-monitor uninstall        # Supprime hooks et container
                                #   --keep-data  préserve la base de données
claude-monitor server           # Démarre le serveur HTTP (foreground, port 18766)
claude-monitor status           # Health check + config
claude-monitor verify           # Lance le vérificateur de critères d'acceptation
claude-monitor score            # Quality scorer — backfill des prompts non scorés
                                #   --max-prompts N  limite les appels API (défaut 20)
claude-monitor score-session <id>  # Score les prompts d'une session spécifique
claude-monitor version
```

Le serveur démarre **automatiquement** lors du premier `SessionStart` de Claude Code.
Pas besoin de le lancer manuellement.

---

## Configuration

Fichier créé par `install` : `~/.claude-monitor/config.json`

```json
{
  "port": 18766,
  "db_url": "postgresql://claude:claude@localhost:5432/claude_system",
  "anthropic_api_key": null
}
```

> `anthropic_api_key: null` désactive Haiku (détection d'ambiguïté + quality scorer inactifs).
> Pour les activer, remplacer `null` par ta clé API Anthropic (ou définir `ANTHROPIC_API_KEY` en variable d'environnement).

Précédence : variable d'environnement > `config.json` > valeurs par défaut.

| Variable d'env      | Équivalent config    | Défaut                                            |
|---------------------|----------------------|---------------------------------------------------|
| `HOOKS_PORT`        | `port`               | `18766`                                           |
| `DATABASE_URL`      | `db_url`             | `postgresql://claude:claude@localhost:5432/...`   |
| `ANTHROPIC_API_KEY` | `anthropic_api_key`  | `null` (Haiku désactivé)                          |

---

## Dashboard

Ouvrir **`http://localhost:18766/dashboard`**

Charts disponibles (sélecteur 7 / 14 / 30 jours) :
- **Coût USD** par jour (basé sur les tarifs Sonnet input/output/cache)
- **Cache hit rate** — ratio `cache_read / (input + cache_read)`
- **Ambiguity rate** — % de prompts détectés comme ambigus
- **Top outils** — appels et durée moyenne par outil
- Compteurs instantanés : sessions, tokens et coût sur la période

```bash
curl http://localhost:18766/health   # → ok
curl http://localhost:18766/status   # → {"ok":true,"apiKey":true}
```

---

## Quality scorer

Score les paires prompt→réponse via Claude Haiku et stocke les scores (1–10) dans
la colonne `prompts.quality_score`. Le scoring est déclenché automatiquement en
fin de session si `ANTHROPIC_API_KEY` est présent.

```bash
claude-monitor score                    # backfill global (20 prompts max)
claude-monitor score --max-prompts 50   # augmenter la limite
claude-monitor score-session <id>       # forcer une session spécifique
```

---

## Guardrails — vérificateur de tâches

La table `tasks` permet de déclarer des tâches avec critères d'acceptation en JSON.
Un trigger PostgreSQL fait passer automatiquement les tâches `done` → `pending_review`
quand des critères sont présents. Le vérificateur évalue 5 types de critères :

| Type          | Description                                      |
|---------------|--------------------------------------------------|
| `sql_count`   | COUNT SQL ≥ min                                  |
| `pattern`     | Regex dans un fichier                            |
| `file_exists` | Existence d'un fichier                           |
| `no_error`    | Commande shell sans `error` dans la sortie       |
| `heuristic`   | Fichier ≥ N caractères                           |

```bash
claude-monitor verify   # évalué automatiquement toutes les 6h au SessionStart
```

---

## Développement

```bash
bun install
bun run dev          # Serveur en mode dev (src/cli.ts server)
bun run build        # Compile les 3 binaires dans dist/
```

Structure :
```
src/
  cli.ts              — Entry point, routeur de sous-commandes
  config.ts           — Config dynamique (~/.claude-monitor/config.json + env)
  db.ts               — Pool PostgreSQL (pg)
  server.ts           — Serveur HTTP Bun
  timers.ts           — Map in-memory pour la durée des outils
  hooks/
    handler.ts        — Logique des 5 événements hooks
    transcript.ts     — Parser JSONL pour agréger les tokens
  routes/
    session.ts        — /session/start, /session/stop
    user-prompt.ts    — /user-prompt (ambiguity detection + Haiku)
    pre-tool.ts       — /pre-tool (timer start)
    post-tool.ts      — /post-tool (timer stop + DB write)
    dashboard.ts      — /dashboard/kpis, /tools, /prompts
  agents/
    verifier.ts       — Vérificateur 5 types de critères
    quality-scorer.ts — Scoring Haiku post-session
  install/
    install.ts        — Docker PG + schéma + hooks
    uninstall.ts      — Nettoyage complet
    settings-merge.ts — Merge atomique dans ~/.claude/settings.json
infra/
  db/schema.sql       — Schéma idempotent (CREATE IF NOT EXISTS + triggers)
  docker-compose.yml  — PostgreSQL 17
public/
  dashboard.html      — Interface Chart.js (embarquée dans le binaire à la compilation)
scripts/
  build.sh            — Compile linux-x64, darwin-arm64, darwin-x64
  install.sh          — Curl installer
```

---

## Roadmap

| Phase | Objectif | Prérequis |
|-------|----------|-----------|
| ✅ v0.1 | Serveur Bun, hooks, PostgreSQL, dashboard, quality scorer | — |
| ✅ v0.2 | Détection ambiguïté (UserPromptSubmit), score-session, PID file | — |
| Phase 3 | pgvector + RAG : retrouver les prompts similaires à faible score | ≥ 200 scores en DB |
| Phase 4 | Embeddings + warning contextuel intégré au UserPromptSubmit | Phase 3 |

---

## Inspirations

Ce projet est une implémentation directe des patterns documentés par
**[Mathieu Grenier](https://mathieugrenier.fr)** dans sa série sur l'outillage d'agents IA :

- **Serveur Bun HTTP persistant** — son audit de production (75 hooks, ~3,3–12,6 s de latence par Edit avec des scripts shell) l'a conduit à migrer vers un serveur HTTP persistant : 0,12–0,3 s après migration. Notre architecture adopte ce choix d'emblée.
- **Token optimization** — règles `rg/Grep before Read`, `head -50`, `LIMIT 50 SQL`, `/compact`
- **Prompt caching** — CLAUDE.md > 1 024 tokens → cache_control automatique (96 % hit rate mesuré dans son env)
- **Observabilité à 4 couches** — collecte, persistance, consolidation (trigger KPI), visualisation
- **Guardrails** — table tasks, trigger auto pending_review, vérificateur 5 types
- **Détection d'ambiguïté** — heuristique longueur + LLM léger (Haiku ici, Qwen3 dans le blog)
