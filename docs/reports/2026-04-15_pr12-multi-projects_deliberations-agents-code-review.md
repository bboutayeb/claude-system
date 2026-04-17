# Délibérations agents — Code review PR #12 feat/multi-projects (2026-04-15)

## Contexte

PR #12 (`feat/multi-projects`) ajoute la segmentation multi-projets : colonne `cwd`/`project` sur `sessions`, endpoints `/dashboard/projects` et `/dashboard/project-stats`, filtre dans `/dashboard/sessions`, dropdown dans le dashboard HTML.

Copilot a révisé la PR en **3 passes** (21h49, 07h31, 08h05 le 15 avril), trouvant 10 problèmes réels. Tous ont été corrigés dans des commits suivants. Ensuite, des agents spécialisés ont effectué une **4e passe finale** sur le code corrigé — c'est le texte de délibération documenté ici.

---

## Chronologie complète

```
PR ouverte (commit initial)
    │
    ▼
Copilot Round 1 (21h49)          → 3 vrais bugs
    ├── basename("/") → "/" (pas NULL)          → FIXÉ: guard `rawBase !== "/"`
    ├── XSS dans loadProjects() innerHTML       → FIXÉ: DOM APIs (createElement)
    └── XSS proj dans sessions tbody           → FIXÉ: escHtml()

Copilot Round 2 (07h31)          → 2 vrais bugs
    ├── Fan-out N×M dans project-stats SQL     → FIXÉ: refacto CTE + CROSS JOIN
    └── typeof cwd pas normalisé avant SQL     → FIXÉ: cwdText = typeof cwd === "string"

Copilot Round 3 (08h05)          → 5 vrais bugs
    ├── Index manquant sur sessions(project)   → FIXÉ: ajouté migration + schema.sql
    ├── XSS dans ambiguities (prompt_text)     → FIXÉ: escHtml() + escAttr()
    ├── loadProjects() sans res.ok check       → FIXÉ: try/catch + early return
    ├── .then(() => load(7)) → crash si fail   → FIXÉ: .finally(() => load(7))
    └── Fan-out dans handleDashboardSessions   → FIXÉ: LATERAL joins (pas de GROUP BY)

Agents finaux (passe 4) — analyse du code corrigé → 3 signalements, tous faux positifs
```

---

## Les 3 délibérations agents et leur verdict

### 1. Agent qualité — `cwdText` est superflu (`src/routes/session.ts:16`)

**Ce que l'agent a vu :**
```typescript
const cwdText = typeof cwd === "string" ? cwd : null   // ligne 16
const rawBase = cwdText ? basename(cwdText) : null      // ligne 17
const project = rawBase && rawBase !== "/" ? rawBase : null

// ...plus loin dans les paramètres SQL :
[..., cwdText, project]                                 // ligne ~30
```

**Pourquoi il a signalé :** `cwdText` ressemble à une variable intermédiaire jetable, utilisée seulement pour calculer `rawBase` à la ligne suivante. L'agent n'a pas vu qu'elle est réutilisée ligne ~30 comme paramètre `$6` dans l'INSERT SQL.

**Verdict : faux positif.** `cwdText` est charge-porteuse — elle sert à deux choses distinctes :
- Protéger `basename()` d'un type non-string (guard TypeScript → runtime safety)
- Passer la valeur normalisée en DB (en distinguant `null` vs une string non-vide)

Supprimer `cwdText` et utiliser directement `cwd ?? null` introduirait une régression : un payload `{cwd: 42}` passerait `42` (un number) à `basename()`, qui lancerait une exception.

---

### 2. Agent qualité — CROSS JOIN "dangereux" dans `handleDashboardProjectStats` (`src/routes/dashboard.ts`)

**La requête incriminée :**
```sql
WITH filtered_sessions AS (...),
     session_stats AS (SELECT COUNT(*), SUM(input_tokens), SUM(output_tokens) FROM filtered_sessions),
     prompt_stats  AS (SELECT AVG(quality_score), COUNT(p.id) FROM filtered_sessions fs LEFT JOIN prompts p ON ...),
     ambiguity_stats AS (SELECT COUNT(a.id) FROM filtered_sessions fs LEFT JOIN ambiguities a ON ...)
SELECT ss.*, ps.*, aps.*
FROM session_stats ss
CROSS JOIN prompt_stats ps
CROSS JOIN ambiguity_stats aps
```

**Pourquoi il a signalé :** `CROSS JOIN` sur des CTE semble contre-intuitif. Dans le cas général, `A CROSS JOIN B` produit `|A| × |B|` lignes.

**Pourquoi c'est correct :** `session_stats`, `prompt_stats`, et `ambiguity_stats` sont des **agrégats nus** (pas de `GROUP BY`). Un agrégat sans `GROUP BY` renvoie toujours **exactement 1 ligne** (même si la table source est vide — il renvoie une ligne avec `NULL`/0). Le CROSS JOIN produit donc `1 × 1 × 1 = 1` ligne, toujours.

Remplacer le CROSS JOIN par un CTE unique avec les trois LEFT JOIN réintroduirait le bug original : si une session a N prompts et M ambiguïtés, `sessions × prompts × ambiguities` = N×M lignes par session → `SUM(input_tokens)` multiplié par M, `AVG(quality_score)` faussé.

**Verdict : faux positif.** Le CROSS JOIN est mathématiquement sûr ici et est la seule façon correcte de combiner les trois agrégats indépendants.

---

### 3. Agent efficacité — Double requête dans `handleDashboardHaikuCost` (`src/routes/dashboard.ts`)

**Ce que l'agent a vu :**
```typescript
// Requête 1 : lignes par jour
const { rows } = await db.query(`SELECT DATE(...), SUM(cost_usd), ... FROM haiku_usage GROUP BY day`, [days])
// Requête 2 : totaux
const { rows: totals } = await db.query(`SELECT SUM(cost_usd), COUNT(*) FROM haiku_usage WHERE ...`, [days])
```

**Pourquoi il a signalé :** Deux requêtes SQL pour récupérer des données qui pourraient sembler combinables (via `ROLLUP` ou une CTE avec `GROUP BY ROLLUP`).

**Pourquoi c'est correct :** Ce code est **préexistant** (hors scope du diff). De plus, la séparation est **intentionnelle pour la précision** : la requête 1 renvoie `ROUND(SUM(cost_usd), 6)` par jour. Sommer ces valeurs arrondies en JavaScript donnerait un total différent de `SUM(cost_usd)` sur toutes les lignes (perte de précision due à l'arrondi intermédiaire). La requête 2 somme les valeurs brutes non-arrondies → total précis.

**Verdict : hors scope + faux positif.** Code préexistant, non modifié par ce diff, et techniquement justifié.

---

## Bilan

Tous les signalements de la passe finale étaient des faux positifs ou hors scope. Les 10 vrais bugs trouvés par Copilot ont tous été adressés dans les commits suivants de la PR. Le code est propre.

| Passe | Auteur | Signalements | Vrais bugs | Faux positifs |
|-------|--------|-------------|-----------|--------------|
| Round 1 | Copilot | 3 | 3 | 0 |
| Round 2 | Copilot | 2 | 2 | 0 |
| Round 3 | Copilot | 5 | 5 | 0 |
| Passe finale | Agents spécialisés | 3 | 0 | 3 |
