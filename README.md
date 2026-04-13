# claude-system

Système d'observabilité pour Claude Code — collecte métriques, tokens, prompts et KPIs via hooks.

## Architecture

- **Hooks server** (`hooks-server/`) — serveur Bun persistant sur le port 18766, reçoit les événements Claude Code et les persiste en PostgreSQL
- **Hooks** (`hooks/`) — scripts shell câblant le cycle de vie Claude Code au serveur HTTP
- **Agents** (`agents/verifier.ts`, `agents/quality-scorer.ts`) — vérificateur automatique et scorer de qualité
- **Dashboard** (`http://localhost:18766/dashboard`) — visualisation des KPIs sans SQL
- **PostgreSQL** (`docker-compose.yml`) — base de données d'observabilité

---

## Quick Start

### Dépendances requises

| Outil | Rôle | Installation |
|-------|------|-------------|
| [mise](https://mise.jdx.dev) | Gestion des runtimes (Bun, Node) | `curl https://mise.run \| sh` |
| [Docker](https://docs.docker.com/get-docker/) | PostgreSQL via Compose | Via site officiel |
| [Claude Code](https://claude.ai/code) | CLI Anthropic (génère les hooks events) | `npm install -g @anthropic-ai/sdk` |
| `ANTHROPIC_API_KEY` | Clé API pour Haiku (ambiguity detector, quality scorer) | Variable d'environnement |

> **WSL2 :** utiliser `localhost` et non `127.0.0.1` dans le navigateur Windows pour accéder au dashboard.

### Installation

```bash
# 1. Cloner le repo
git clone <repo> && cd claude-system

# 2. Installer les runtimes (Bun + Node déclarés dans .mise.toml)
mise install

# 3. Installer les dépendances npm
mise exec -- bun install

# 4. Démarrer PostgreSQL
docker compose up -d

# 5. Appliquer toutes les migrations SQL (001 → 008)
for f in infra/db/*.sql; do
  psql postgresql://claude:claude@localhost:5432/claude_system -f "$f"
done
```

### Configurer les hooks Claude Code

Dans les settings Claude Code (`~/.claude/settings.json` ou via `/settings`), pointer les hooks vers ce repo :

```json
{
  "hooks": {
    "SessionStart":     [{ "type": "command", "command": "/chemin/vers/hooks/session-start.sh" }],
    "SessionStop":      [{ "type": "command", "command": "/chemin/vers/hooks/session-stop.sh" }],
    "PreToolUse":       [{ "type": "command", "command": "/chemin/vers/hooks/pre-tool-use.sh" }],
    "UserPromptSubmit": [{ "type": "command", "command": "/chemin/vers/hooks/user-prompt-submit.sh" }]
  }
}
```

### Démarrage

Le serveur hooks démarre **automatiquement** au premier `SessionStart` (ouverture de Claude Code).
Pour le démarrer manuellement :

```bash
mise exec -- bun run hooks-server/server.ts
```

### Vérifier que tout fonctionne

```bash
curl http://localhost:18766/health          # → ok
curl http://localhost:18766/status          # → {"ok":true,"apiKey":true}
curl "http://localhost:18766/dashboard/kpis?days=7"  # → JSON KPIs
```

Puis ouvrir **`http://localhost:18766/dashboard`** dans le navigateur.

---

## Vérificateur automatique

`agents/verifier.ts` vérifie les critères d'acceptation des tâches en cours. Il est déclenché
**automatiquement depuis le hook SessionStart**, au plus une fois toutes les 6 heures, uniquement
lorsque Claude Code est ouvert.

**Aucun crontab système n'est modifié.** Le timestamp du dernier run est stocké dans :
```
${XDG_CACHE_HOME:-~/.cache}/claude-system-verifier-last-run
```

Pour désactiver le déclenchement automatique, supprimer ce fichier ou retirer le bloc
"Verifier contextuel" de `hooks/session-start.sh`.

Les logs du vérificateur sont dans `/tmp/claude-verifier.log`.

---

## Dashboard

Ouvrir **`http://localhost:18766/dashboard`** dans le navigateur pour visualiser les KPIs :
coût USD, cache hit rate, ambiguity rate, top outils — avec sélecteur de période (7 / 14 / 30 jours).

Le serveur hooks doit être démarré (automatique au premier SessionStart).

---

## Quality scorer

`agents/quality-scorer.ts` score les paires prompt→réponse en lisant les transcripts JSONL
et en appelant Claude Haiku. Les scores (1-10) alimentent la colonne `prompts.quality_score`.

**Les transcripts sont capturés automatiquement** à partir de la première session après la mise
en place des hooks. Pour scorer les interactions accumulées, lancer manuellement :

```bash
bun run quality-scorer
```

> À faire après quelques jours de sessions pour avoir suffisamment de données.
> Cible : >= 200 scores avant d'activer le pipeline pgvector/RAG (Phase 3).
