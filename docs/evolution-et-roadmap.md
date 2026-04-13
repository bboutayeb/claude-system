# Évolutions et Roadmap — claude-monitor

## Évolutions récentes (session 2026-04-13)

### Clé API opérationnelle
- Diagnostic : le token `sk-ant-oat01-` (OAuth Claude Code CLI) n'est pas utilisable avec l'API Anthropic directe — il faut une clé `sk-ant-api03-` depuis console.anthropic.com
- Correction du JSON malformé dans `~/.claude-monitor/config.json` (valeur non quotée)

### Quality scorer fonctionnel
- **Bloquant résolu** : le compte API n'avait pas de solde → tous les appels Haiku échouaient silencieusement avec `[SKIP]` dans le binaire compilé (le binaire masquait les erreurs `400 credit balance too low`)
- 36 prompts scorés en backfill, scores de 2 à 9/10
- Le scorer reste un agent CLI séparé (`claude-monitor score`), pas intégré au flux temps-réel

### Dashboard : score qualité
- Nouvelle carte KPI "Qualité moy. prompts" (score /10)
- Nouveau graphe "Qualité prompts / jour" (courbe violette, axe 0-10)
- Données issues de `/dashboard/prompts` (endpoint existant), chargé en parallèle avec `kpis` et `tools`

### Détection d'ambiguïté : refonte
**Problèmes corrigés :**
1. Heuristique trop large — `\b(this|that|it)\b` bloquait "Refactor this function to use async/await"
2. `length < 15` ignorait le verdict de Haiku après l'avoir payé
3. Timeout 400ms trop court — Haiku prend 800ms-1s, timeout était systématiquement atteint
4. `Promise.race` abandonnait la requête sans l'annuler (tokens facturés, résultat jeté)

**Solution :**
- Heuristique multi-signaux : `< 10 chars` → toujours ambigu ; `10-40 chars` → 1 trigger suffit ; `> 40 chars` → 2 triggers minimum
- Type `SuggestionResult` avec 3 états distincts : `question` / `clear` / `unavailable` (timeout ou pas de clé)
- `AbortController` pour annuler réellement la requête Haiku en cas de timeout
- Timeout porté à **1200ms** — Haiku répond maintenant dans le délai sur les prompts bloqués
- Labels `[IA]` / `[heuristique]` dans le message de blocage pour traçabilité

### CLI status
- Affiche `http://localhost:PORT/dashboard` au lieu de `http://127.0.0.1:PORT/dashboard` pour compatibilité WSL/macOS

---

## Roadmap

### Court terme

#### Heuristique — cas limites restants
- Allowlist de prompts courts valides : `yes`, `no`, `continue`, `go ahead`, `/compact`
- Tester des prompts réels pour mesurer le taux de faux positifs avec la nouvelle heuristique

#### Quality scorer — déclenchement automatique
- Actuellement : CLI manuelle (`claude-monitor score`)
- Cible : déclencher en `PostToolUse` ou `Stop` hook (fire-and-forget, après la session)
- Risque : coût API si beaucoup de sessions actives → ajouter un flag `--max-prompts N`

#### Dashboard — améliorations UX
- Afficher les scores par session (pas seulement la moyenne journalière)
- Lien cliquable vers le transcript depuis les entrées de la table `prompts`
- Colonne `source` sur les ambiguities : `[IA]` vs `[heuristique]` visible dans le dashboard

### Moyen terme

#### Métriques de coût Haiku
- Tracer le coût des appels ambiguity detection séparément du coût des sessions Claude Code
- Alerte si le coût Haiku dépasse un seuil configurable

#### Retour utilisateur sur les blocages
- Permettre à l'utilisateur de marquer un blocage comme "faux positif"
- Utiliser ce feedback pour ajuster les seuils heuristiques

#### Binary release
- Rebâtir le binaire compilé avec les dernières corrections (le binaire actuel masque les erreurs API)
- Pipeline CI pour build automatique sur tag

### Long terme

#### Scoring en temps réel
- Intégrer un scoring léger directement dans le flux `PostToolUse` plutôt qu'en batch
- Nécessite une stratégie de cache pour éviter les appels redondants sur les sessions longues

#### Multi-projets
- Segmenter les KPIs par projet (`cwd`) dans le dashboard
- Comparer la qualité et l'ambiguité entre projets
