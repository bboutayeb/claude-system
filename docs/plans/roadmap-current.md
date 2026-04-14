# Étape 7 — Scoring temps réel (long terme, ~2h)

> **Branche :** `feat/realtime-scoring` depuis `integ`  
> **Contexte complet :** `@docs/plans/2026-04-13_2259_roadmap-implementation.md`

---

## Problème

Le scoring qualité est actuellement **batch uniquement** : il se déclenche une fois à la fin de la session (`Stop` hook), lit le transcript JSONL depuis le disque, et score chaque prompt via Haiku. L'utilisateur n'a aucun feedback pendant la session.

Les prompts courts comme `oui` / `continue` ne peuvent pas être scorés isolément — ils n'ont de sens que dans leur contexte conversationnel.

---

## Approche : scoring par échange complet

Plutôt que de scorer chaque prompt isolément, le scoring temps réel évalue un **échange complet** = le prompt courant + le contexte des 2-3 messages précédents. Cela résout le cas des prompts courts qui sont parfaitement clairs dans leur contexte conversationnel.

Le scoring batch au `Stop` reste en place comme filet de sécurité (il score les prompts manqués par le temps réel).

---

## Fichiers

| Fichier | Action |
|---------|--------|
| `infra/db/migrations/012_haiku_usage_realtime_source.sql` | Créer — migration CHECK constraint |
| `infra/db/schema.sql` | Modifier — mettre à jour le CHECK de haiku_usage |
| `src/agents/quality-scorer.ts` | Modifier — exporter `scoreExchange`, `findAssistantResponse`, `ScoreResult` |
| `src/agents/realtime-scorer.ts` | Créer — module principal du scoring temps réel |
| `src/config.ts` | Modifier — ajouter `realtime_scoring` et `realtime_scoring_throttle_s` |
| `src/routes/post-tool.ts` | Modifier — appel fire-and-forget `maybeScore()` |
| `src/routes/user-prompt.ts` | Modifier — appel synchrone `markNewPrompt()` |
| `src/routes/session.ts` | Modifier — appel `clearSession()` au Stop |

---

## Changements

### 1. Migration DB — `infra/db/migrations/012_haiku_usage_realtime_source.sql`

```sql
ALTER TABLE haiku_usage DROP CONSTRAINT IF EXISTS haiku_usage_source_check;
ALTER TABLE haiku_usage ADD CONSTRAINT haiku_usage_source_check
  CHECK (source IN ('ambiguity', 'scoring', 'realtime-scoring'));
```

Mettre aussi à jour `infra/db/schema.sql` pour les installs fresh (table `haiku_usage`).

### 2. Exports depuis `src/agents/quality-scorer.ts`

Ajouter `export` à `scoreExchange`, `findAssistantResponse`, et `ScoreResult`. Pas de changement de logique.

### 3. Nouveau module `src/agents/realtime-scorer.ts` (~100 lignes)

**State en mémoire :**
```typescript
interface SessionState {
  lastPromptTs: number      // timestamp du dernier UserPromptSubmit
  lastScoreTs: number       // timestamp du dernier score réussi
  transcriptPath: string | null
}
const sessions = new Map<string, SessionState>()
const THROTTLE_MS = 30_000  // 30s par défaut, configurable
```

**API publique :**

- `markNewPrompt(sessionId: string): void` — synchrone, appelé par user-prompt après chaque INSERT INTO prompts. Met à jour `lastPromptTs = Date.now()`. Crée l'entrée dans la Map si elle n'existe pas encore.

- `maybeScore(sessionId: string): Promise<void>` — appelé fire-and-forget depuis post-tool. Logique :
  1. Guard : `config.realtime_scoring === false` ou pas d'API key → return
  2. Dedup : `lastPromptTs <= lastScoreTs` → return (pas de nouveau prompt depuis le dernier score)
  3. Throttle : `Date.now() - lastScoreTs < THROTTLE_MS` → return
  4. Résoudre `transcriptPath` : query DB une fois (`SELECT transcript_path FROM sessions WHERE id = $1`), cache dans la Map. Si null, return.
  5. Lire les ~100 dernières lignes du transcript (pour éviter de parser des mégaoctets sur les longues sessions)
  6. Extraire les 2-3 derniers échanges via `extractRecentExchanges(lines, 3)`
  7. Si moins d'un échange trouvé → return
  8. Appeler `scoreExchange(client, exchanges[last].prompt, exchanges[last].response)` (réutilisé depuis quality-scorer.ts)
  9. Mettre à jour `lastScoreTs = Date.now()` dans la Map
  10. `UPDATE prompts SET quality_score = $1 WHERE id = (SELECT id FROM prompts WHERE session_id = $2 AND quality_score IS NULL ORDER BY created_at DESC LIMIT 1)`
  11. Enregistrer dans `haiku_usage` avec `source = 'realtime-scoring'`
  12. Tout wrappé dans try/catch — erreurs loggées, jamais propagées

- `clearSession(sessionId: string): void` — supprime l'entrée de la Map. Appelé au Stop pour éviter les fuites mémoire.

**Helper privé :**
- `extractRecentExchanges(lines: string[], count = 3): Array<{ prompt: string, response: string }>` — parse le JSONL en arrière pour trouver les N dernières paires user/assistant. Réutilise la même logique de parsing que `findAssistantResponse` (type checks sur `entry.type`, `entry.message.role`, extraction du contenu text).

**Client Anthropic :** Lazy singleton au niveau du module (initialisé au premier appel à `maybeScore`).

### 4. Config — `src/config.ts`

Ajouter à l'interface `Config` et au loading :
```typescript
realtime_scoring: boolean           // default: true
realtime_scoring_throttle_s: number // default: 30
```

Lus depuis `~/.claude-monitor/config.json` avec fallback aux defaults. Le throttle en ms = `config.realtime_scoring_throttle_s * 1000`.

### 5. Wiring des routes existantes

**`src/routes/post-tool.ts`** — après l'INSERT tool_calls, avant le `return new Response("ok")` :
```typescript
import { maybeScore } from "../agents/realtime-scorer"
// Fire-and-forget — ne bloque jamais la réponse
if (session_id) maybeScore(session_id).catch(() => {})
```

**`src/routes/user-prompt.ts`** — après chaque INSERT INTO prompts (chemin allowlisted ligne ~126 ET chemin normal ligne ~134) :
```typescript
import { markNewPrompt } from "../agents/realtime-scorer"
if (session_id) markNewPrompt(session_id)
```

**`src/routes/session.ts`** — dans `handleSessionStop`, après l'UPDATE sessions :
```typescript
import { clearSession } from "../agents/realtime-scorer"
if (session_id) clearSession(session_id)
```

---

## Vérification

```bash
# 1. Appliquer la migration
psql postgresql://claude:claude@localhost:5432/claude_system \
  -f infra/db/migrations/012_haiku_usage_realtime_source.sql

# 2. Démarrer le dev server
bun run src/cli.ts server

# 3. Simuler un flow complet (curl)
# a) POST /session/start avec transcript_path
# b) POST /user-prompt → markNewPrompt déclenché
# c) POST /post-tool → maybeScore déclenché (après ~1s pour que le transcript soit écrit)
# d) Vérifier le score :
psql postgresql://claude:claude@localhost:5432/claude_system \
  -c "SELECT id, quality_score FROM prompts ORDER BY id DESC LIMIT 3"
# e) Vérifier le coût Haiku :
psql postgresql://claude:claude@localhost:5432/claude_system \
  -c "SELECT source, cost_usd FROM haiku_usage ORDER BY id DESC LIMIT 5"

# 4. Vérifier le throttle :
# Deux POST /post-tool consécutifs → seul le 1er score (2ème bloqué par throttle 30s)

# 5. Build compilé
bash scripts/build.sh
./dist/claude-monitor-linux-x64 version  # → 0.2.0 (pas de bump pour étape 7)
```

---

## Estimation coût

- Throttle : max 1 appel/30s/session = max 2 appels/min
- ~1000 input tokens + 10 output tokens par appel ≈ $0.0008/appel
- Session typique (1h, activité intermittente) : ~20-40 appels ≈ $0.02-0.03
- Visible immédiatement dans le dashboard coûts Haiku (source `realtime-scoring`)

---

## Statut

- [ ] Migration 012 créée et appliquée
- [ ] Exports quality-scorer.ts
- [ ] Module realtime-scorer.ts créé
- [ ] Config étendue
- [ ] Routes wirées (post-tool, user-prompt, session)
- [ ] Tests manuels (flow complet + throttle)
- [ ] Build compilé vérifié
- [ ] PR vers `integ` mergée
