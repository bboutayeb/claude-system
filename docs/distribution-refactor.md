# Distribution refactor — état d'avancement

_Date : 2026-04-13_

## Objectif

Transformer claude-monitor d'un outil couplé à un seul répertoire en une CLI installable par n'importe qui, qui monitore **toutes** les sessions Claude Code.

**Choix validés** : PostgreSQL conservé (Docker), binaire Bun compilé, toutes les features incluses.

---

## Ce qui a été fait

### 1. Nouveau layout `src/`

Tout le code a été restructuré (l'ancien `hooks-server/`, `hooks/`, `agents/` reste en place pour l'instant) :

```
src/
  cli.ts                    # Entry point, routeur de sous-commandes
  config.ts                 # Lit ~/.claude-monitor/config.json + env vars
  db.ts                     # Pool PG (connection string depuis config)
  timers.ts                 # Timers in-memory pour duration_ms
  server.ts                 # Serveur HTTP (dashboard HTML embarqué au build)
  routes/
    session.ts
    pre-tool.ts
    post-tool.ts
    user-prompt.ts
    dashboard.ts
  hooks/
    handler.ts              # Remplace les 4 scripts shell
    transcript.ts           # Parse JSONL (remplace grep | jq -sc)
  agents/
    verifier.ts             # Lit config partagée, plus de DB URL hardcodée
    quality-scorer.ts       # Skip silencieux si API key absente
  install/
    install.ts              # Docker PG + migrations + merge hooks global
    uninstall.ts            # Nettoyage propre (--keep-data optionnel)
    settings-merge.ts       # Merge atomique dans ~/.claude/settings.json
```

### 2. CLI — sous-commandes

```
claude-monitor install          # Docker PG + schema + hooks globaux
claude-monitor uninstall        # Nettoyage (--keep-data pour garder la DB)
claude-monitor server           # Démarre le serveur HTTP (foreground)
claude-monitor hook <event>     # Gère un événement hook (lit stdin)
claude-monitor status           # Health check + config
claude-monitor verify           # Verifier de tâches
claude-monitor score            # Quality scorer
claude-monitor version
```

### 3. Configuration dynamique

`~/.claude-monitor/config.json` (créé par `install`) :
```json
{
  "port": 18766,
  "db_url": "postgresql://claude:claude@localhost:5432/claude_system",
  "anthropic_api_key": null
}
```

Précédence : `env var` > `config.json` > defaults.

### 4. Settings-merge atomique

`install` fusionne les hooks dans `~/.claude/settings.json` :
- Backup avant toute modification (`settings.json.bak`)
- Écriture atomique via tmp → rename (évite la corruption)
- Identifie les hooks claude-monitor par le mot `claude-monitor` dans la commande
- Nettoie également les hooks legacy dans le `.claude/settings.json` du projet courant

### 5. Scripts shell supprimés (logique dans le binaire)

| Ancien script | Remplacé par |
|---|---|
| `hooks/session-start.sh` | `src/hooks/handler.ts` → `onSessionStart()` |
| `hooks/session-stop.sh` | `src/hooks/handler.ts` → `onSessionStop()` + `transcript.ts` |
| `hooks/pre-tool-use.sh` | `src/hooks/handler.ts` → `onPreToolUse()` |
| `hooks/user-prompt-submit.sh` | `src/hooks/handler.ts` → `onUserPromptSubmit()` |

L'auto-start du serveur utilise `process.execPath` (correct en binaire compilé).

### 6. Schema SQL consolidé

`infra/db/schema.sql` — 8 migrations fusionnées en 1 fichier idempotent :
- `CREATE TABLE IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS`
- `CREATE OR REPLACE FUNCTION`
- `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`

### 7. Docker Compose nettoyé

`infra/docker-compose.yml` — le volume `./infra/db:/docker-entrypoint-initdb.d` a été supprimé. Les migrations sont maintenant lancées par le binaire via connexion PG directe.

### 8. `package.json` mis à jour

Tous les scripts pointent vers `src/cli.ts` :
```json
"dev":             "bun run src/cli.ts server",
"verify":          "bun run src/cli.ts verify",
"score":           "bun run src/cli.ts score",
"install:hooks":   "bun run src/cli.ts install",
"uninstall:hooks": "bun run src/cli.ts uninstall",
"build":           "bash scripts/build.sh"
```

### 9. Scripts de distribution

- `scripts/build.sh` — compile pour linux-x64, darwin-arm64, darwin-x64
- `scripts/install.sh` — curl installer (détecte OS/arch, télécharge, exécute `install`)

### 10. `.claude/settings.json` (projet) mis à jour

Les hooks pointent maintenant vers `~/.claude-monitor/bin/claude-monitor hook <event>` au lieu des chemins absolus legacy.

---

## Tests effectués

```bash
# CLI
bun run src/cli.ts                    # → affiche l'aide
bun run src/cli.ts status             # → Server: running, API key: present

# Hooks (avec serveur existant sur :18766)
echo '{"session_id":"test","model":"claude-sonnet-4-6"}' | bun run src/cli.ts hook session-start
# → [claude-monitor] server OK — ANTHROPIC_API_KEY present

echo '{"tool_use_id":"abc","session_id":"test","tool_name":"Read"}' | bun run src/cli.ts hook pre-tool-use
# → {}

echo '{"prompt":"refaire ça","session_id":"test"}' | bun run src/cli.ts hook user-prompt-submit
# → {"decision":"block","reason":"Votre prompt semble ambigu..."}

# Serveur (port alternatif)
HOOKS_PORT=18767 bun run src/cli.ts server &
curl http://127.0.0.1:18767/health    # → ok
curl http://127.0.0.1:18767/status    # → {"ok":true,"apiKey":true}
```

---

## Prochaines étapes

### Étape A — Builder le binaire compilé

```bash
bun run build
# → dist/claude-monitor-linux-x64
# → dist/claude-monitor-darwin-arm64
# → dist/claude-monitor-darwin-x64
```

Vérifier que le binaire compilé fonctionne :
```bash
./dist/claude-monitor-linux-x64 version
./dist/claude-monitor-linux-x64 install
```

### Étape B — Tester l'install from scratch

Sur une machine propre (ou en simulant) :
1. `./claude-monitor-linux-x64 install`
2. Vérifier que Docker PG démarre et que `~/.claude/settings.json` est mis à jour
3. Ouvrir Claude Code dans n'importe quel répertoire → vérifier les métriques dans PG

### Étape C — GitHub Actions release workflow

Créer `.github/workflows/release.yml` qui sur tag push :
1. Compile les 3 binaires
2. Crée une GitHub Release avec les assets

### Étape D — README onboarding

```bash
curl -fsSL https://github.com/<owner>/claude-monitor/releases/latest/download/install.sh | bash
```

### Étape E — Nettoyage

Une fois le binaire validé en prod :
- Supprimer `hooks-server/` (remplacé par `src/`)
- Supprimer `hooks/*.sh` (remplacés par `src/hooks/handler.ts`)
- Supprimer `agents/` à la racine (remplacé par `src/agents/`)
- Supprimer `docker-compose.yml` à la racine (remplacé par `infra/docker-compose.yml`)

---

## Données existantes

**Les données PostgreSQL ne sont pas perdues.** Le container Docker et son volume (`postgres_data`) sont intacts — rien n'a été supprimé. Le nouveau code se connecte au même `claude_system` sur le même port 5432.

**Attention** : les hooks dans `.claude/settings.json` (projet) pointent maintenant vers `~/.claude-monitor/bin/claude-monitor` qui n'existe pas encore. Les hooks échoueront silencieusement (fire-and-forget) jusqu'à ce que tu exécutes `bun run build` puis `./dist/claude-monitor-linux-x64 install`.
