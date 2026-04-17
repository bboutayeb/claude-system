# Étape 8 — Multi-projets (long terme, ~2h)

> **Branche :** `feat/multi-projects` depuis `integ`  
> **Contexte complet :** `@docs/plans/2026-04-13_2259_roadmap-implementation.md`

---

## Problème

Toutes les sessions sont agrégées sans distinction de projet. Un utilisateur qui travaille sur plusieurs codebases ne peut pas segmenter ses stats (tokens, scores, ambiguïtés) par projet.

Le payload `SessionStart` de Claude Code expose déjà le champ `cwd` — il suffit de le capturer et de le propager.

---

## Approche

- `project` = dernier segment du `cwd` (ex. `/home/user/Code/myapp` → `myapp`)
- Les `kpi_snapshots` restent globaux (refacto trigger PostgreSQL trop risquée) — on filtre dynamiquement côté API
- Nouveau endpoint `/dashboard/project-stats` pour les stats par projet (calcul on-the-fly depuis `sessions` + jointures)
- Dropdown projet dans le header du dashboard, filtre la table sessions + les stats

---

## Fichiers

| Fichier | Action |
|---------|--------|
| `infra/db/migrations/013_sessions_project.sql` | Créer — ajouter `cwd` et `project` à `sessions` |
| `infra/db/schema.sql` | Modifier — mettre à jour la table `sessions` |
| `src/hooks/handler.ts` | Modifier — ajouter `cwd` dans le body envoyé à `/session/start` |
| `src/routes/session.ts` | Modifier — capturer `cwd`, calculer `project = basename(cwd)` |
| `src/routes/dashboard.ts` | Modifier — filtrer sessions par `project` + nouveau endpoint `/dashboard/projects` et `/dashboard/project-stats` |
| `public/dashboard.html` | Modifier — dropdown projet dans le header, filtre propagé aux requêtes |

---

## Changements

### 1. Migration DB — `infra/db/migrations/013_sessions_project.sql`

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cwd TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project TEXT;

-- Backfill : pas de cwd historique → project reste NULL (affiché "—" dans le dashboard)
```

Mettre à jour `infra/db/schema.sql` : ajouter `cwd TEXT` et `project TEXT` après `transcript_path`.

### 2. Hook handler — `src/hooks/handler.ts`

Dans `onSessionStart()`, ajouter `cwd` au body :

```typescript
const body = {
  session_id: payload.session_id,
  model: payload.model,
  source: payload.source,
  agent_type: payload.agent_type,
  transcript_path: payload.transcript_path,
  cwd: payload.cwd,   // ← nouveau
}
```

### 3. Route session — `src/routes/session.ts`

Dans `handleSessionStart()` :
```typescript
import { basename } from "path"

const { session_id, model, source, agent_type, transcript_path, cwd } = body as { ... }
const project = cwd ? basename(cwd as string) : null

// Dans l'INSERT :
`INSERT INTO sessions (id, model, source, agent_type, transcript_path, cwd, project)
 VALUES ($1, $2, $3, $4, $5, $6, $7)
 ON CONFLICT (id) DO UPDATE SET
   ...
   cwd     = COALESCE(EXCLUDED.cwd, sessions.cwd),
   project = COALESCE(EXCLUDED.project, sessions.project)`
// params : [..., cwd ?? null, project]
```

### 4. Routes dashboard — `src/routes/dashboard.ts`

**Nouvel endpoint `GET /dashboard/projects`** — retourne la liste des projets distincts :
```sql
SELECT DISTINCT project FROM sessions
WHERE project IS NOT NULL
ORDER BY project
```

**Nouvel endpoint `GET /dashboard/project-stats?project=X&days=N`** — stats dynamiques par projet :
```sql
SELECT
  COUNT(DISTINCT s.id)                                  AS total_sessions,
  COALESCE(SUM(s.input_tokens), 0)                      AS total_input_tokens,
  COALESCE(SUM(s.output_tokens), 0)                     AS total_output_tokens,
  ROUND(AVG(p.quality_score), 2)                        AS avg_quality,
  COUNT(DISTINCT p.id)                                  AS total_prompts,
  COUNT(DISTINCT a.id)                                  AS total_ambiguities
FROM sessions s
LEFT JOIN prompts p ON p.session_id = s.id
LEFT JOIN ambiguities a ON a.session_id = s.id
WHERE s.project = $1
  AND s.started_at >= CURRENT_DATE - $2::int
```

**Endpoint existant `GET /dashboard/sessions`** — ajouter le paramètre `project` optionnel :
```typescript
const project = url.searchParams.get("project") // null = tous les projets
// Ajouter dans le WHERE : AND ($3::text IS NULL OR s.project = $3)
// Ajouter s.project, s.cwd dans le SELECT
```

### 5. Dashboard — `public/dashboard.html`

**Dropdown projet dans le header** :
- Charger `/dashboard/projects` au démarrage → populate `<select id="project-filter">`
- Option "Tous les projets" en premier (value = `""`)
- Stocker la sélection dans `sessionStorage`

**Propagation du filtre** :
- `loadSessions()` ajoute `?project=X` si sélection non vide
- `loadProjectStats()` charge `/dashboard/project-stats?project=X&days=N` et affiche une mini-carte KPI "Projet actif"
- Changement du dropdown → recharge sessions + project-stats (pas les KPI globaux — ceux-ci restent globaux)

---

## Vérification

```bash
# 1. Appliquer la migration
psql postgresql://claude:claude@localhost:5432/claude_system \
  -f infra/db/migrations/013_sessions_project.sql

# 2. Démarrer le dev server
bun run src/cli.ts server

# 3. Simuler un SessionStart avec cwd
curl -s -X POST http://127.0.0.1:18766/session/start \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-mp","model":"claude-sonnet-4-5","cwd":"/home/user/Code/myapp"}'

# 4. Vérifier project extrait
psql postgresql://claude:claude@localhost:5432/claude_system \
  -c "SELECT id, cwd, project FROM sessions WHERE id = 'test-mp'"
# → project = 'myapp'

# 5. Vérifier endpoints
curl -s http://127.0.0.1:18766/dashboard/projects | jq .
curl -s "http://127.0.0.1:18766/dashboard/project-stats?project=myapp&days=7" | jq .
curl -s "http://127.0.0.1:18766/dashboard/sessions?project=myapp" | jq '.sessions | length'

# 6. Build compilé
bash scripts/build.sh
./dist/claude-monitor-linux-x64 version
```

---

## Statut

- [x] Migration 013 créée et appliquée
- [x] `handler.ts` passe `cwd` au serveur
- [x] `session.ts` capture `cwd` et calcule `project`
- [x] Endpoint `/dashboard/projects`
- [x] Endpoint `/dashboard/project-stats`
- [x] Filtre `project` dans `/dashboard/sessions`
- [x] Dashboard : dropdown projet + propagation filtre
- [x] Tests manuels (SessionStart → project extrait, filtre dashboard)
- [x] Build compilé vérifié
- [ ] PR vers `integ` mergée
