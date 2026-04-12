# Roadmap v2 — suite du plan

*Mis à jour le 2026-04-13*

---

## Acquis (plan-ameliorations.md — terminé)

| # | Action | État |
|---|---|---|
| 1 | Traçabilité sessions (`model`, `source`, `agent_type`) | ✅ migrations 005 + code |
| 2 | Logger tous les prompts — table `prompts` | ✅ migration 006 + code |
| 3 | KPIs enrichis — 10 métriques dont coût USD | ✅ migration 007 + trigger |
| 4 | Verifier contextuel — hook SessionStart, XDG, sans crontab | ✅ |

---

## Phase 1 — Dashboard (à faire après ~quelques jours de données)

### Objectif

Rendre `kpi_snapshots` lisible sans passer par SQL. Une page HTML avec Chart.js,
alimentée par des routes JSON sur un serveur Bun.

### Décisions à trancher avant de coder

1. **Port séparé ou mutualisé ?**
   - Option A — port 18767 dédié (plan initial) : démarrage indépendant, redémarrage propre
   - Option B — routes `/dashboard/*` ajoutées au serveur 18766 existant : un seul process à gérer
   - Recommandation : **Option B** — le serveur 18766 est déjà lancé au SessionStart, ajouter des routes
     est moins invasif qu'un second process.

2. **Granularité temporelle**
   - `kpi_snapshots` est journalier → vues "aujourd'hui / 7j / 30j" sans jointure
   - Sub-journalier (dernière heure) → requête directe sur `sessions` et `tool_calls`
   - Commencer par daily uniquement, ajouter le sub-journalier si utile

### Fichiers à créer / modifier

| Fichier | Action |
|---|---|
| `hooks-server/routes/dashboard.ts` | Routes JSON : `/dashboard/kpis?days=7`, `/dashboard/tools`, `/dashboard/prompts` |
| `hooks-server/server.ts` | Brancher les nouvelles routes |
| `public/dashboard.html` | Page HTML Chart.js (charts: coût USD, cache hit rate, ambiguity rate, top outils) |

### Flux de données

```
Browser → GET /dashboard/kpis?days=7
  → SELECT * FROM kpi_snapshots ORDER BY snapshot_date DESC LIMIT 7
  → JSON [{date, total_sessions, estimated_cost_usd, cache_hit_rate, ambiguity_rate, tool_breakdown}]
  → Chart.js render
```

### Charts prévus

- Ligne : `estimated_cost_usd` par jour
- Ligne : `cache_hit_rate` par jour
- Ligne : `ambiguity_rate` par jour
- Barres : top outils (`tool_breakdown` JSONB dénormalisé côté serveur)
- Compteurs : sessions today, tokens today, coût today

### Prérequis

Aucun — les données sont en place. Attendre 3-5 jours de données réelles pour que les
courbes aient du sens.

---

## Phase 2 — Quality score sur les prompts

### Objectif

Remplir la colonne `prompts.quality_score` (actuellement `null` partout) en scorant
les paires prompt→réponse extraites des transcripts JSONL.

### Prérequis bloquant : capturer `transcript_path`

`transcript_path` arrive dans chaque payload hook (SessionStart, PreToolUse, PostToolUse, Stop)
mais n'est jamais stocké. Le pipeline a besoin de retrouver le transcript d'une session.

**Migration 008 :**
```sql
ALTER TABLE sessions ADD COLUMN transcript_path TEXT;
```

**`hooks/session-start.sh`** — extraire et envoyer :
```bash
BODY=$(echo "$PAYLOAD" | mise exec -- jq '{session_id, model, source, agent_type, transcript_path}')
```

**`hooks-server/routes/session.ts`** — persister dans `handleSessionStart` et `handleSessionStop`
(Stop est le moment le plus fiable, le fichier est complet à ce stade).

### Pipeline batch post-session (`agents/quality-scorer.ts`)

Déclenché manuellement ou depuis le verifier, une fois par session terminée sans `quality_score` :

```
1. SELECT s.id, s.transcript_path FROM sessions s
   JOIN prompts p ON p.session_id = s.id
   WHERE p.quality_score IS NULL AND s.transcript_path IS NOT NULL
   LIMIT 50

2. Pour chaque session :
   - Lire le fichier JSONL transcript
   - Extraire les paires {role: "user", content} → {role: "assistant", content}
   - Scorer chaque paire via Haiku (prompt: "Rate this exchange 0-10. JSON: {score, reason}")
   - UPDATE prompts SET quality_score = $score WHERE session_id = $id AND prompt_text = $text
```

### Heuristiques de scoring (sans LLM, à titre de fallback)

| Signal | Poids |
|---|---|
| Longueur réponse > 200 chars | +1 |
| Présence de blocs de code | +2 |
| Réponse contient "je ne sais pas" / "I don't know" | -3 |
| Prompt ambigu (`is_ambiguous = true`) | -1 |
| Session avec `output_tokens = 0` | -5 (waste) |

### Quand lancer ?

```sql
-- Vérifier si on a assez de matière
SELECT COUNT(*) FROM prompts WHERE quality_score IS NOT NULL;
-- Cible : >= 200 avant de passer à la Phase 3
```

---

## Phase 3 — pgvector + RAG (dépend de Phase 2)

### Objectif

Au moment d'un nouveau prompt, retrouver les paires historiques similaires avec un
score faible, et injecter un avertissement contextuel dans le system prompt.

### Prérequis stricts

- Phase 2 terminée : `prompts.quality_score` rempli sur ≥ 200 sessions
- Extension pgvector disponible dans le container PostgreSQL
- Modèle d'embedding : `bge-m3` (via Ollama local) ou API OpenAI `text-embedding-3-small`

### Migration 009

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE prompts ADD COLUMN embedding vector(1024);  -- dimension bge-m3
CREATE INDEX prompts_embedding_idx ON prompts USING hnsw (embedding vector_cosine_ops);
```

### Pipeline d'embedding (`agents/embedder.ts`)

```
1. SELECT id, prompt_text FROM prompts
   WHERE embedding IS NULL AND quality_score IS NOT NULL
   LIMIT 100

2. Pour chaque prompt :
   - Appel API embedding (bge-m3 ou text-embedding-3-small)
   - UPDATE prompts SET embedding = $vector WHERE id = $id
```

### Intégration dans `user-prompt.ts` (hook UserPromptSubmit)

```
1. Embedder le prompt entrant (< 50ms avec cache)
2. SELECT prompt_text, quality_score, session_id
   FROM prompts
   WHERE quality_score < 4
   ORDER BY embedding <=> $query_vector
   LIMIT 3

3. Si résultats similaires (distance cosine < 0.15) :
   - Ajouter un warning dans le contexte :
     "Attention : des prompts similaires ont produit des réponses de faible qualité.
      Préciser [X] améliorerait probablement le résultat."
```

### Métriques pour valider l'impact

Comparer `ambiguity_rate` et `avg_quality_score` avant/après activation du RAG
sur une fenêtre de 30 jours. Si delta < 5%, le RAG n'apporte pas assez.

---

## Ordre d'implémentation

```
Maintenant       → quelques jours de données réelles
Semaine 1        → Phase 1 : Dashboard (routes JSON + Chart.js)
Semaine 2        → Phase 2 prérequis : migration 008 + capturer transcript_path
Semaine 2-3      → Phase 2 : quality-scorer.ts + accumulation des scores
À >= 200 scores  → Phase 3 : pgvector + embeddings + RAG dans user-prompt
```
