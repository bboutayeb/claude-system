# claude-system

Système d'observabilité pour Claude Code — collecte métriques, tokens, prompts et KPIs via hooks.

## Architecture

- **Hooks server** (`hooks-server/`) — serveur Bun persistant sur le port 18766, reçoit les événements Claude Code et les persiste en PostgreSQL
- **Hooks** (`hooks/`) — scripts shell câblant le cycle de vie Claude Code au serveur HTTP
- **Agents** (`agents/verifier.ts`) — vérificateur automatique des tâches en cours
- **PostgreSQL** (`docker-compose.yml`) — base de données d'observabilité

## Démarrage

```bash
docker compose up -d    # PostgreSQL
# Le serveur hooks démarre automatiquement au premier SessionStart
```

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
