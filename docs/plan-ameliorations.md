# Plan d'améliorations — v2

*Mis à jour le 2026-04-13 — à reviewer ensemble avant implémentation*

---

## Découvertes clés (payloads hooks Claude Code)

Avant de planifier, voici ce que les hooks nous envoient réellement :

| Champ | SessionStart | PreToolUse | PostToolUse | UserPromptSubmit | Stop |
|---|---|---|---|---|---|
| `session_id` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `model` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `source` | ✅ (`startup`, `resume`, `clear`, `compact`) | ❌ | ❌ | ❌ | ❌ |
| `agent_type` | ✅ (si `--agent`) | ✅ (si subagent) | ✅ (si subagent) | ❌ | ❌ |
| `tool_name` | ❌ | ✅ | ✅ | ❌ | ❌ |
| `tool_use_id` | ❌ | ✅ | ✅ | ❌ | ❌ |
| `tool_input` | ❌ | ✅ | ✅ | ❌ | ❌ |
| `tool_response` | ❌ | ❌ | ✅ | ❌ | ❌ |
| `prompt` | ❌ | ❌ | ❌ | ✅ | ❌ |
| `transcript_path` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `usage` / tokens | ❌ | ❌ | ❌ | ❌ | ❌ |
| `cost` | ❌ | ❌ | ❌ | ❌ | ❌ |

**Conséquences** :
- **`model`** arrive dans SessionStart mais on le jette → à capturer
- **`source`** arrive dans SessionStart mais on le jette → c'est notre `agent_routed`
- **`tool_calls.input_tokens`** est une colonne morte (PostToolUse n'envoie pas `usage`) → 1 seule valeur non-zéro sur 349 lignes
- **Tokens et coûts** : seul moyen = parser le transcript JSONL (déjà fait dans `session-stop.sh`)
- **Coût USD** : calculable à partir des tokens dans `sessions` × pricing Anthropic

---

## Étape 1 — Traçabilité des sessions (~20min)

### Problème
`session-start.sh` reçoit `model`, `source` et `agent_type` mais ne transmet que `session_id`.
C'est l'équivalent du `agent_routed` du blog — la donnée arrive déjà, on la jette.

### Actions

**Migration `005_sessions_tracing.sql`** :
```sql
ALTER TABLE sessions ADD COLUMN model TEXT;
ALTER TABLE sessions ADD COLUMN source TEXT;          -- startup | resume | clear | compact
ALTER TABLE sessions ADD COLUMN agent_type TEXT;      -- null = interactif, 'verifier' = cron, etc.
```

**`hooks/session-start.sh`** — extraire et transmettre les 3 champs :
```bash
MODEL=$(echo "$PAYLOAD" | jq -r '.model // null')
SOURCE=$(echo "$PAYLOAD" | jq -r '.source // null')
AGENT_TYPE=$(echo "$PAYLOAD" | jq -r '.agent_type // null')
```

**`hooks-server/routes/session.ts`** — persister dans `handleSessionStart` :
```sql
INSERT INTO sessions (id, model, source, agent_type)
VALUES ($1, $2, $3, $4)
ON CONFLICT (id) DO UPDATE SET model = COALESCE(EXCLUDED.model, sessions.model)
```

### Fichiers modifiés
- `infra/db/005_sessions_tracing.sql` (nouveau)
- `hooks/session-start.sh`
- `hooks-server/routes/session.ts`

---

## Étape 2 — Logger tous les prompts (~30min)

### Problème
`user-prompt.ts` ne logge que les prompts bloqués (dans `ambiguities`).
On perd 100% des prompts clairs → impossible de calculer `ambiguity_rate` ou `quality_score` plus tard.

### Actions

**Nouvelle table `prompts`** (migration `006_prompts.sql`) :
```sql
CREATE TABLE prompts (
  id          SERIAL PRIMARY KEY,
  session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_text TEXT NOT NULL,
  char_length INTEGER GENERATED ALWAYS AS (length(prompt_text)) STORED,
  is_ambiguous BOOLEAN DEFAULT false,
  quality_score NUMERIC,              -- null pour l'instant, rempli plus tard
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX prompts_session_idx ON prompts(session_id);
CREATE INDEX prompts_created_idx ON prompts(created_at);
```

**`hooks-server/routes/user-prompt.ts`** — logger AVANT le check d'ambiguïté :
```typescript
// Log every prompt — fire-and-forget
db.query(
  "INSERT INTO prompts (session_id, prompt_text, is_ambiguous) VALUES ($1, $2, $3)",
  [session_id, prompt.slice(0, 2000), isAmbiguous(prompt)]
).catch(() => {})
```

### Fichiers modifiés
- `infra/db/006_prompts.sql` (nouveau)
- `hooks-server/routes/user-prompt.ts`

---

## Étape 3 — KPIs enrichis + consolidation refonte (~1h)

### Problème actuel
- 4 métriques seulement, calculées depuis `sessions` uniquement
- `waste_rate` = "sessions avec 0 output tokens" (très grossier)
- `input_tokens` avg 236 alors que `cache_read` est à 1.5M → le vrai volume est invisible
- `tool_calls.input_tokens` est mort → le nettoyer

### Nouvelles métriques

**Migration `007_kpi_v2.sql`** — étendre `kpi_snapshots` :

| Colonne | Type | Source | Description |
|---|---|---|---|
| `total_tokens` | BIGINT | sessions | `SUM(input + output + cache_read + cache_write)` — volume réel |
| `total_output_tokens` | BIGINT | sessions | `SUM(output_tokens)` |
| `total_cache_write` | BIGINT | sessions | `SUM(cache_write_tokens)` — coût du priming |
| `estimated_cost_usd` | NUMERIC(10,4) | sessions | formule pricing Anthropic |
| `total_tool_calls` | INTEGER | tool_calls | `COUNT(*)` du jour |
| `avg_tool_duration_ms` | INTEGER | tool_calls | `AVG(duration_ms)` |
| `tool_breakdown` | JSONB | tool_calls | `[{tool, count, avg_ms}]` — top outils |
| `total_prompts` | INTEGER | prompts | `COUNT(*)` du jour |
| `ambiguity_rate` | NUMERIC | prompts | `ambigus / total` |
| `avg_prompt_length` | INTEGER | prompts | `AVG(char_length)` |

**Formule de coût estimé** (pricing Sonnet 4 2026) :
```sql
(input_tokens * 3.0 / 1000000)           -- $3/M input
+ (output_tokens * 15.0 / 1000000)       -- $15/M output
+ (cache_read_tokens * 0.30 / 1000000)   -- $0.30/M cache read
+ (cache_write_tokens * 3.75 / 1000000)  -- $3.75/M cache write
```

**Réécriture `upsert_kpi_snapshot()`** — joint `sessions` + `tool_calls` + `prompts`

**Nettoyage** : `ALTER TABLE tool_calls DROP COLUMN input_tokens` (colonne morte)

### Fichiers modifiés
- `infra/db/007_kpi_v2.sql` (nouveau)
- `infra/db/004_kpi_trigger.sql` (réécriture de la fonction)

---

## Étape 4 — Cron vérificateur (~15min)

### Problème
`agents/verifier.ts` existe mais s'exécute manuellement. Le blog a un agent récurrent.

### Action
Crontab système, toutes les 6h :
```cron
0 */6 * * * cd /home/zaibaker/Code/Perso/IA/prompt && mise exec -- bun run agents/verifier.ts >> /tmp/verifier.log 2>&1
```

Vérifiable avec `crontab -l` et `cat /tmp/verifier.log`.

Aucun fichier modifié dans le repo — configuration système uniquement.

---

## Étape 5 — Dashboard (reportée, dépend de 1-3)

Serveur Bun sur port 18767, routes JSON + page HTML Chart.js.
À planifier une fois les KPIs enrichis en place.

---

## RAG / Pipeline QA — ce que ça implique concrètement

La pipeline d'extraction QA consiste à :
1. **Parser les fichiers `transcript_path`** (JSONL) de chaque session terminée
2. **Extraire les paires** : prompt utilisateur → réponse assistant
3. **Scorer chaque paire** (quality_score via LLM ou heuristique)
4. **Stocker** dans une table avec embedding vectoriel (pgvector)
5. **Requêter** lors d'un nouveau prompt pour trouver les paires similaires à faible score

C'est un pipeline de **batch processing post-session**, pas du temps réel.

### Pourquoi attendre ?

Les étapes 1-3 du plan ci-dessus construisent les fondations exactes dont le RAG a besoin :
- **Étape 1** (traçabilité) → savoir quel modèle a produit la réponse
- **Étape 2** (log prompts) → corpus de prompts à embedder plus tard
- **Étape 3** (KPIs + coût) → mesurer si le RAG améliore réellement la qualité

L'ordre naturel est : **collecter d'abord, enrichir ensuite**. Le RAG sans données = du code qui tourne à vide. Après ~200 sessions avec quality_score, pgvector + embeddings bge-m3 deviendra pertinent.

---

## Résumé de priorisation

| # | Action | Effort | Ce que ça débloque |
|---|---|---|---|
| **1** | Traçabilité sessions (model, source, agent_type) | 20min | Savoir quel modèle coûte combien |
| **2** | Logger tous les prompts + table `prompts` | 30min | Corpus pour quality_score + ambiguity_rate |
| **3** | KPIs enrichis + consolidation (10 métriques, coût USD) | 1h | Visibilité complète, optimisation data-driven |
| **4** | Cron vérificateur | 15min | Garde-fous automatiques |
| — | *Dashboard* | *2h* | *Visualisation (après 1-3)* |
| — | *pgvector + RAG* | *4h+* | *Après 200+ sessions avec quality_score* |

### Ordre d'implémentation : 1 → 2 → 3 → 4
