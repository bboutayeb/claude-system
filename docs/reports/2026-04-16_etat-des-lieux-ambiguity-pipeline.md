# État des lieux — Pipeline de détection d'ambiguïté

**Date :** 2026-04-16  
**Contexte :** Après la direction A (fix heuristique, commit suivant d830c74).  
**Objectif de ce document :** Fournir un contexte complet pour implémenter la direction B (pgvector + RAG) quand le volume le justifie.

---

## 1. L'architecture de référence (article Mathieu Grenier)

Le pipeline décrit dans l'article source est un pipeline à **4 étages indépendants**, chacun ayant un rôle précis et non-interchangeable :

```
UserPromptSubmit
    │
    ▼
┌───────────────────────────────────────────────────────┐
│  ÉTAGE 1 — Heuristique (gardien binaire léger)        │
│  "Est-ce manifestement ambigu ?"                      │
│  Coût : ~0 (pure CPU, pas de réseau)                  │
│  Triggers : mots-clés FR + longueur < 30 chars        │
│  Si NON → laisser passer (fin du pipeline)            │
│  Si OUI → passer à l'étage 2                          │
└───────────────────────────────────────────────────────┘
    │ (ambigu potentiel)
    ▼
┌───────────────────────────────────────────────────────┐
│  ÉTAGE 2 — pgvector (intelligence contextuelle)       │
│  "Ce prompt ressemble-t-il à des sessions passées     │
│   qui se sont mal passées ?"                          │
│  Coût : ~0 (requête SQL locale, index vectoriel)      │
│  Input : embedding du prompt courant                  │
│  Lookup : vecteurs de sessions avec mauvaise note     │
│  Si similarité < seuil → laisser passer (fin)         │
│  Si similarité ≥ seuil → passer à l'étage 3          │
└───────────────────────────────────────────────────────┘
    │ (session similaire trouvée)
    ▼
┌───────────────────────────────────────────────────────┐
│  ÉTAGE 3 — RAG (enrichissement de contexte)           │
│  "Préparer le contexte pour que le LLM pose           │
│   une bonne question"                                 │
│  Coût : ~0 (requête SQL)                              │
│  Récupère : prompt précédent clair, historique        │
│   de la session, note qualité associée                │
│  Construit : un contexte enrichi pour le LLM          │
└───────────────────────────────────────────────────────┘
    │ (contexte enrichi)
    ▼
┌───────────────────────────────────────────────────────┐
│  ÉTAGE 4 — LLM local (rédacteur uniquement)           │
│  "Formuler UNE question de clarification pertinente"  │
│  Coût : ~0€ (qwen3:4b local, ~350ms)                  │
│  Input : contexte RAG + prompt courant                │
│  Output : 1 question ciblée, max 20 mots              │
└───────────────────────────────────────────────────────┘
    │
    ▼
UserPromptSubmit bloqué avec suggestion de clarification
```

**Triggers de l'article** (liste exhaustive, pas de regex, simples substring) :
```ts
const AMBIGUOUS_TRIGGERS = [
  'refaire', 'relancer', 'les recommandations',
  'implementer les recommandations', 'la phase suivante',
  'cette strategie', 'ce plan', 'implementer'
]
// + prompt.length < 30
```

**Point clé** : le LLM local (etape 4) **ne fire que si** les étages 1 + 2 ont tous les deux levé un signal. Il n'est jamais utilisé comme filet de sécurité pour les faux positifs de l'heuristique.

---

## 2. Notre état actuel (après direction A)

```
UserPromptSubmit
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  ÉTAGE 1 — Heuristique (direction A)                 │
│  Triggers FR seulement + longueur < 30 chars         │
│  Aligné avec l'article source                        │
└──────────────────────────────────────────────────────┘
    │ (ambigu potentiel)
    ▼
    [ÉTAGE 2 manquant — pgvector]
    [ÉTAGE 3 partiel — 1 query session, sans vecteurs]
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  ÉTAGE 4 — Haiku API (substitut imparfait)           │
│  Rôle actuel : juge + correcteur + rédacteur         │
│  Rôle cible (direction B) : rédacteur uniquement     │
│  Coût : ~0.001$/appel, timeout 3s                    │
└──────────────────────────────────────────────────────┘
```

**Ce qu'on a :**
- ✓ Étage 1 — opérationnel et bien calibré
- ✓ Étage 4 — Haiku API fonctionnel, contexte session partiel (d830c74)
- ✗ Étage 2 — absent (pgvector)
- ✗ Étage 3 — partiel (dernier prompt clair de session, pas de scoring ni similarité)

**Différence structurelle clé :** Dans l'article, le LLM fire seulement si pgvector a trouvé une session similaire mal notée. Dans notre implémentation, Haiku fire sur tout prompt flaggé par l'heuristique — il joue le rôle du juge que pgvector devrait jouer.

---

## 3. Ce qu'il faudrait pour implémenter la direction B

### 3.1 Infrastructure

**pgvector** — extension PostgreSQL pour la recherche vectorielle :
```sql
-- Activer l'extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Colonne embedding sur la table prompts
ALTER TABLE prompts ADD COLUMN embedding vector(1536);

-- Index pour la recherche de similarité (cosine distance)
CREATE INDEX idx_prompts_embedding ON prompts USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

**Embedding model** : l'article utilise un modèle local (pas précisé, probablement `nomic-embed-text` via Ollama). Pour nous avec l'API Anthropic, il faudrait soit :
- `text-embedding-3-small` (OpenAI, $0.00002/1K tokens) — pas natif Anthropic
- Un modèle Voyage AI (Anthropic recommande `voyage-3-lite`, ~$0.00002/1K tokens)
- Ou Ollama local avec `nomic-embed-text` (gratuit, ~80ms, 768 dims)

### 3.2 Pipeline d'embedding

Chaque prompt doit être vectorisé avant d'être stocké :

```ts
// Dans handleUserPrompt, avant l'INSERT dans prompts :
const embedding = await getEmbedding(prompt.slice(0, 512))

// INSERT avec embedding
db.query(
  "INSERT INTO prompts (session_id, prompt_text, is_ambiguous, embedding) VALUES ($1, $2, $3, $4) RETURNING id",
  [session_id, prompt.slice(0, 2000), ambiguous, JSON.stringify(embedding)]
)
```

### 3.3 Scoring de qualité des sessions

Pour que pgvector soit utile, il faut savoir quelles sessions "se sont mal passées". Deux sources possibles :
- **Signal existant** : `quality_score` dans la table `prompts` (via `quality-scorer.ts`)
- **Signal futur** : feedback explicite de l'utilisateur (marquer une session comme mauvaise)

Requête de similarité (étage 2) :
```sql
-- Trouver les prompts les plus similaires parmi les sessions mal notées
SELECT p.prompt_text, p.session_id, s.quality_score
FROM prompts p
JOIN sessions s ON p.session_id = s.id
WHERE s.quality_score < 0.5  -- seuil à calibrer
  AND p.embedding IS NOT NULL
ORDER BY p.embedding <=> $1  -- cosine distance avec l'embedding du prompt courant
LIMIT 3;
```

### 3.4 Enrichissement RAG (étage 3)

Si pgvector trouve des sessions similaires mal notées, construire un contexte enrichi :

```ts
// Contexte pour Haiku
const context = `
Prompt actuel : ${currentPrompt}

Contexte de session :
- Dernier prompt clair de cette session : ${lastClearPrompt}

Sessions similaires passées (mal notées) :
${similarSessions.map(s => `- "${s.prompt_text}" (score: ${s.quality_score})`).join('\n')}

Ces sessions ont eu des difficultés. Le prompt actuel est-il ambigu ? Si oui, quelle clarification demander ?
`
```

---

## 4. Schéma de migration (direction B)

```sql
-- Migration: ajout embedding à prompts
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS idx_prompts_embedding
  ON prompts USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

La migration doit aussi mettre à jour `infra/db/schema.sql` (source de vérité pour les fresh installs).

---

## 5. Prérequis et dépendances

| Composant | Statut | Action requise |
|-----------|--------|----------------|
| pgvector extension | Absent | `CREATE EXTENSION vector` dans la migration |
| Embedding model | Non choisi | Choisir : Voyage AI / OpenAI / Ollama local |
| Scoring sessions | Partiel (quality-scorer.ts) | Vérifier que `quality_score` est bien renseigné |
| Colonne embedding | Absente | Migration SQL |
| Index vectoriel | Absent | Migration SQL |
| Pipeline embedding | Absent | Nouveau module `src/lib/embedding.ts` |
| Intégration user-prompt | Absent | Modifier `handleUserPrompt` |

---

## 6. Quand implémenter la direction B

**Seuil suggéré** : ≥ 1000 prompts en DB avec quality_score renseigné.

**Pourquoi 1000 :** En dessous, l'index IVFFlat pgvector est peu utile (pas assez de vecteurs pour que la recherche de similarité soit significative). L'article source implique qu'il avait un historique suffisant pour que pgvector détecte des patterns.

**Signal de déclenchement** :
```sql
SELECT COUNT(*) FROM prompts WHERE quality_score IS NOT NULL;
-- Lancer direction B quand ce count >= 1000
```

---

## 7. Ce que le commit d830c74 a préparé pour la direction B

Le context session ajouté dans `getSuggestion()` est un **acompte direct sur l'étage 3** :

```ts
// Déjà en place — c'est l'étage 3 partiel
const { rows } = await db.query(
  "SELECT prompt_text FROM prompts WHERE session_id = $1 AND NOT is_ambiguous ORDER BY created_at DESC LIMIT 1",
  [sessionId]
)
```

Quand la direction B sera implémentée, cette requête sera enrichie avec les résultats pgvector au lieu d'une simple dernière ligne.

---

## 8. Résumé des fichiers à créer/modifier pour la direction B

| Fichier | Action | Contenu |
|---------|--------|---------|
| `infra/db/migrations/XXXX_add_pgvector.sql` | Créer | `CREATE EXTENSION vector`, `ALTER TABLE prompts ADD COLUMN embedding vector(1536)`, index |
| `infra/db/schema.sql` | Modifier | Ajouter la colonne `embedding` et l'index au schéma final |
| `infra/docker-compose.yml` | Modifier | Utiliser `pgvector/pgvector:pg17` au lieu de `postgres:17` |
| `src/lib/embedding.ts` | Créer | Client embedding (Voyage/OpenAI/Ollama), fonction `getEmbedding(text): Promise<number[]>` |
| `src/routes/user-prompt.ts` | Modifier | Appel embedding avant INSERT, requête similarité pgvector dans `getSuggestion()` |
