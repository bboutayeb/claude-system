# claude-monitor

Système d'observabilité pour Claude Code — collecte métriques, tokens, prompts et KPIs via hooks.
Distribué comme un binaire compilé unique, sans dépendance de runtime.

## Installation

```bash
curl -fsSL https://github.com/bboutayeb/claude-system/releases/latest/download/install.sh | bash
```

L'installateur :
1. Détecte l'OS / l'architecture (Linux x64, macOS arm64/x64)
2. Télécharge le binaire dans `~/.claude-monitor/bin/`
3. Démarre un container Docker PostgreSQL et applique le schéma
4. Injecte les hooks dans `~/.claude/settings.json`

> **Prérequis** : [Docker](https://docs.docker.com/get-docker/) et `ANTHROPIC_API_KEY` dans l'environnement.
> **WSL2** : utiliser `localhost` (pas `127.0.0.1`) dans le navigateur Windows pour le dashboard.

---

## Utilisation

```bash
claude-monitor server       # Démarre le serveur HTTP (foreground, port 18766)
claude-monitor status       # Health check + config
claude-monitor verify       # Vérificateur de critères d'acceptation
claude-monitor score        # Quality scorer (prompt → score 1-10)
claude-monitor install      # (Re)installe Docker PG + hooks globaux
claude-monitor uninstall    # Supprime hooks et container (--keep-data pour garder la DB)
claude-monitor version
```

Le serveur démarre **automatiquement** lors du premier `SessionStart` de Claude Code. Pas besoin de le lancer manuellement.

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

Précédence : variable d'environnement > `config.json` > valeurs par défaut.

---

## Dashboard

Ouvrir **`http://localhost:18766/dashboard`** — coût USD, cache hit rate, ambiguity rate, top outils (sélecteur 7 / 14 / 30 jours).

```bash
curl http://localhost:18766/health   # → ok
curl http://localhost:18766/status   # → {"ok":true,"apiKey":true}
```

---

## Quality scorer

Score les paires prompt→réponse via Claude Haiku et stocke les scores (1-10) dans PostgreSQL.

```bash
claude-monitor score
```

Silencieux si `ANTHROPIC_API_KEY` est absent. Cible : ≥ 200 scores avant d'activer le pipeline pgvector/RAG.

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
  cli.ts             # Entry point, routeur de sous-commandes
  config.ts          # Config dynamique (~/.claude-monitor/config.json + env)
  db.ts              # Pool PostgreSQL
  server.ts          # Serveur HTTP + dashboard HTML embarqué
  hooks/handler.ts   # Logique des 4 événements hooks
  agents/            # verifier.ts, quality-scorer.ts
  install/           # install.ts, uninstall.ts, settings-merge.ts
infra/
  db/schema.sql      # Schéma idempotent (CREATE IF NOT EXISTS)
  docker-compose.yml # PostgreSQL 17
scripts/
  build.sh           # Compile linux-x64, darwin-arm64, darwin-x64
  install.sh         # Curl installer
```
