# Plan d'implémentation — Roadmap claude-monitor

## Contexte

Le projet `claude-monitor` est fonctionnel (hooks, dashboard, quality scorer, ambiguity detection). La roadmap (`docs/evolution-et-roadmap.md`) liste 8 chantiers répartis en court/moyen/long terme. Ce plan les organise en étapes implémentables, priorisées par valeur et dépendances.

---

## Étape 1 — Allowlist prompts courts + slash commands (court terme, ~15 min)

**Problème :** Les prompts < 10 chars comme `yes`, `no`, `continue` sont systématiquement flaggés ambigus. Les slash commands Claude (`/compact`, `/help`, `/clear`, etc.) et les réponses de validation d'agents ne doivent jamais être bloquées.

**Fichier :** `src/routes/user-prompt.ts`

**Changements :**
1. Ajouter deux listes avant `isAmbiguous()` :
   - **Slash commands** : tout prompt commençant par `/` (regex `/^\/\w+/`) — couvre `/compact`, `/help`, `/clear`, `/review`, `/commit`, et les futures commandes
   - **Réponses valides courtes** : `Set` contenant `yes`, `no`, `ok`, `oui`, `non`, `continue`, `go ahead`, `stop`, `done`
2. Dans `handleUserPrompt()`, court-circuiter **avant** l'heuristique si le prompt matche l'une de ces listes → retourner `{}` directement
3. **Le prompt est quand même logué** dans `prompts` avec `is_ambiguous = false` — les stats restent complètes
4. Pas d'appel Haiku déclenché → économie directe

**Vérification :** `echo '{"prompt":"/compact"}' | bun run src/cli.ts hook user-prompt-submit` → `{}`  
`echo '{"prompt":"yes"}' | bun run src/cli.ts hook user-prompt-submit` → `{}`  
Vérifier en DB que les deux sont bien insérés dans `prompts` avec `is_ambiguous = false`

---

## Étape 2 — Quality scorer automatique au Stop (court terme, ~30 min)

**Problème :** Le scoring est uniquement manuel (`claude-monitor score`). L'objectif est de le déclencher automatiquement à la fin de chaque session.

**Fichiers :** `src/hooks/handler.ts`, `src/agents/quality-scorer.ts`

**Changements :**
1. Dans `quality-scorer.ts`, extraire la logique de `runAll()` en une fonction exportée `scoreSession(sessionId: string)` qui ne score que les prompts de cette session
2. Dans `handler.ts` → `onSessionStop()`, après le POST `/session/stop`, appeler `scoreSession()` en fire-and-forget (`scoreSession(sessionId).catch(console.error)`) — non-bloquant pour le hook
3. Garde : skip si pas d'API key configurée
4. Le CLI `claude-monitor score` existant reste fonctionnel pour le backfill (score les prompts sans `quality_score`)
5. Ajouter un flag `--max-prompts N` (défaut 20) au CLI `score` pour limiter les appels API en mode batch

**Note coût :** Seuls les prompts de la session terminée sont scorés (pas tous les prompts en attente). Haiku à $0.80/MTok input avec max 10 tokens output → ~$0.001 par prompt scoré. Une session de 10 prompts coûte ~$0.01 en scoring.

**Vérification :** Lancer une session Claude Code, la terminer, vérifier que les `quality_score` sont remplis dans `prompts` en < 30s

---

## Étape 3 — Dashboard UX : scores par session + source ambiguïté (court terme, ~45 min)

**Problème :** Le dashboard n'affiche que la moyenne journalière de qualité, pas le détail par session. La colonne `source` (`[IA]` vs `[heuristique]`) n'est pas visible.

**Fichiers :** `src/routes/dashboard.ts`, `public/dashboard.html`, `infra/db/schema.sql`

**Changements :**
1. **Nouvel endpoint** `GET /dashboard/sessions?days=N` : retourne les sessions avec leurs prompts agrégés (nb prompts, score moyen, nb ambigus)
2. **Nouvelle table HTML** dans le dashboard : liste des sessions récentes avec colonnes `date | modèle | prompts | score moy | ambigus`
3. **Colonne source sur ambiguïtés** : ajouter `source TEXT` à la table `ambiguities` (migration `009_ambiguity_source.sql`), peupler depuis le préfixe `[IA]`/`[heuristique]` dans `user-prompt.ts`
4. **Lien transcript** : dans la table sessions, ajouter un lien cliquable vers le fichier transcript (endpoint `/transcript?path=...` servant le fichier brut)

**Vérification :** Ouvrir `http://localhost:18766/dashboard`, vérifier la nouvelle table et les liens

---

## Étape 4 — Métriques de coût Haiku (moyen terme, ~45 min)

**Problème :** Aucun tracking des appels Haiku (ambiguity + scoring). Impossible de savoir combien coûte le monitoring lui-même.

**Fichiers :** `infra/db/schema.sql`, `src/routes/user-prompt.ts`, `src/agents/quality-scorer.ts`, `src/routes/dashboard.ts`, `public/dashboard.html`

**Changements :**
1. **Nouvelle table** `haiku_usage` : `id SERIAL, source TEXT ('ambiguity'|'scoring'), input_tokens INT, output_tokens INT, cost_usd NUMERIC, created_at TIMESTAMPTZ`
2. Dans `user-prompt.ts` et `quality-scorer.ts`, lire `response.usage` après chaque appel Haiku et insérer dans `haiku_usage`
3. **Calcul de coût** : Haiku pricing ($0.80/MTok input, $4.00/MTok output)
4. **Nouveau endpoint** `GET /dashboard/haiku-cost?days=N` : coût total + breakdown par source
5. **Dashboard** : nouvelle carte KPI "Coût Haiku" + courbe journalière
6. **Alerte configurable** : nouveau champ `haiku_cost_alert_usd` dans `config.json` (défaut null = désactivé), log warning si dépassé

**Vérification :** Lancer `claude-monitor score`, vérifier les entrées dans `haiku_usage`, vérifier la carte dans le dashboard

---

## Étape 5 — Feedback faux positifs (moyen terme, ~1h)

**Problème :** L'utilisateur ne peut pas signaler qu'un blocage était un faux positif. Pas de boucle d'amélioration.

**Fichiers :** `infra/db/schema.sql`, `src/server.ts`, `public/dashboard.html`

**Changements :**
1. Ajouter `false_positive BOOLEAN DEFAULT NULL` à la table `ambiguities` (migration)
2. **Endpoint** `POST /ambiguity/:id/feedback` avec body `{ false_positive: true|false }`
3. **Dashboard** : dans une nouvelle vue "Ambiguïtés récentes", afficher les blocages avec bouton "Faux positif" par ligne
4. **KPI** : taux de faux positifs sur le dashboard (nb false_positive / nb total ambiguities)
5. Optionnel : ajuster les seuils heuristiques dynamiquement en fonction du taux de FP

**Vérification :** Provoquer un blocage, aller sur le dashboard, cliquer "Faux positif", vérifier le changement en DB

---

## Étape 6 — Rebuild binaire + CI (moyen terme, ~30 min)

**Problème :** Le binaire compilé actuel masque les erreurs API. Le CI existe mais n'a pas été relancé.

**Fichiers :** `scripts/build.sh`, `.github/workflows/release.yml`, `src/config.ts`

**Changements :**
1. Bumper `VERSION` dans `src/config.ts` → `"0.2.0"`
2. Vérifier que `scripts/build.sh` produit un binaire fonctionnel localement
3. Tagger `v0.2.0` et vérifier que le workflow GitHub Actions produit les 3 binaires
4. Mettre à jour les notes de release avec le changelog

**Vérification :** Télécharger le binaire depuis la release, `./claude-monitor version` → `0.2.0`

---

## Étape 7 — Scoring temps réel (long terme, ~2h)

**Problème :** Le scoring batch post-session ne donne pas de feedback immédiat pendant la session.

**Approche : scoring par échange complet**

Plutôt que de scorer chaque prompt isolément, le scoring temps réel évalue un **échange complet** = le prompt courant + le contexte des 2-3 messages précédents (prompt+réponse). Cela résout le cas des prompts courts comme "oui" ou "continue" qui n'ont pas de sens isolément mais sont parfaitement clairs dans leur contexte conversationnel.

**Changements :**
1. Dans `onPostToolUse()`, après chaque réponse assistant significative, déclencher un scoring léger fire-and-forget
2. Le payload envoyé à Haiku inclut les **2-3 derniers échanges** (pas juste le dernier prompt), pour que le score reflète la qualité de l'interaction dans son contexte
3. Cache en mémoire (Map `session→[dernierTimestamp, dernierScore]`) pour éviter de scorer chaque tool call intermédiaire — ne scorer que quand un nouvel échange utilisateur est détecté
4. Throttle : max 1 scoring toutes les 30s par session pour contrôler les coûts
5. **Perspective LLM local** : cette architecture (fire-and-forget, échange complet) est conçue pour être compatible avec un futur LLM local (Ollama, llama.cpp) qui remplacerait Haiku sans changer l'interface

**Vérification :** Ouvrir une session, envoyer 5 prompts, vérifier que les scores apparaissent dans `prompts` en quasi-temps-réel sans latence perceptible

---

## Étape 8 — Multi-projets (long terme, ~2h)

**Problème :** Toutes les sessions sont agrégées sans distinction de projet.

**Changements :**
1. Ajouter `cwd TEXT` à `sessions` (capturé depuis le payload hook `SessionStart`)
2. Extraire le nom de projet depuis le `cwd` (dernier segment du path)
3. Filtrer le dashboard par projet (dropdown dans le header)
4. Segmenter les KPI snapshots par projet (clé composite `snapshot_date + project`)

**Vérification :** Lancer des sessions dans 2 projets différents, vérifier le filtre dans le dashboard

---

## Ordre d'implémentation recommandé

| Priorité | Étape | Valeur | Effort |
|----------|-------|--------|--------|
| 1 | Allowlist prompts courts + slash commands | Élimine les faux positifs, laisse passer les commandes Claude | ~15 min |
| 2 | Quality scorer auto au Stop | Le scoring devient invisible | ~30 min |
| 3 | Dashboard UX | Visibilité fine des sessions | ~45 min |
| 4 | Métriques coût Haiku | Contrôle du coût du monitoring | ~45 min |
| 5 | Feedback faux positifs | Boucle d'amélioration | ~1h |
| 6 | Rebuild binaire | Distribution fiable v0.2.0 | ~30 min |
| 7 | Scoring temps réel (échanges complets) | Feedback immédiat, compatible LLM local | ~2h |
| 8 | Multi-projets | Segmentation par cwd | ~2h |

---

## Statut d'exécution (mise à jour : 2026-04-13 23:20)

### Court terme

- [x] **Étape 1** — Allowlist slash commands
  - ✅ Implémentation : regex `/^\\/\\w+/` pour tous les slash commands Claude
  - ✅ Set vide `ALLOWLISTED_RESPONSES` réservé pour feedback utilisateur (futur — étape 5)
  - ✅ Validation : `/compact`, `/help`, `/clear` passent sans blocage; `yes`, `no` restent ambigus
  - ✅ Logging intact : prompts allowlistés loggés avec `is_ambiguous = false`
  - ✅ PR #1 mergée dans `integ` (commit: `79aafa5`)
  - **Prochaine étape :** Étape 2

- [ ] **Étape 2** — Quality scorer automatique au Stop
- [ ] **Étape 3** — Dashboard UX : scores par session + source ambiguïté

### Moyen terme

- [ ] **Étape 4** — Métriques de coût Haiku
- [ ] **Étape 5** — Feedback faux positifs (populate `ALLOWLISTED_RESPONSES`)
- [ ] **Étape 6** — Rebuild binaire v0.2.0

### Long terme

- [ ] **Étape 7** — Scoring temps réel (échanges complets)
- [ ] **Étape 8** — Multi-projets

---

## Git Flow

| Branche | Statut | Notes |
|---------|--------|-------|
| `main` | Stable (prod-ready) | Merges uniquement depuis `integ` (releases éprouvées) |
| `integ` | Intégration | Étape 1 mergée ✅ |
| `feat/allowlist-short-prompts` | ✅ Merged | → `integ` le 2026-04-13 23:19 |
| `feat/quality-scorer-auto-stop` | À créer | Prochaine feature branch |
