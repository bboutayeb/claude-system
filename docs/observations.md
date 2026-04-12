# Observations post-implémentation — Phases 1 à 4

Date : 2026-04-12

Ce document liste les écarts et améliorations constatés après la mise en place des
phases 1-4 du plan (`ultraplan.md`). Chaque observation indique si elle était prévue
dans le plan, son impact réel, et une proposition concrète.

---

## 1. `duration_ms` toujours NULL ✅ Corriger

**Statut plan** : prévu — `tool_calls.duration_ms` figure dans le schéma Phase 1 (§1.2)

**Écart** : le payload PostToolUse de Claude Code ne contient pas de champ durée.
Le schéma attend une valeur que le hook ne peut pas fournir directement.

**Impact** : la requête `AVG(duration_ms) FROM tool_calls` retourne NULL pour tous
les outils. La métrique latence par outil — citée comme indicateur clé dans le blog
(article observabilité, URL 10) — est actuellement inopérante.

**Proposition** : mesurer côté serveur avec un chronomètre in-memory.

```
PreToolUse  → Map.set(tool_use_id, Date.now())
PostToolUse → duration_ms = Date.now() - Map.get(tool_use_id)
```

Changements requis :
- `hooks-server/server.ts` : `const timers = new Map<string, number>()`
- `routes/pre-tool.ts` : stocker `timers.set(tool_use_id, Date.now())`
- `routes/post-tool.ts` : calculer le delta, supprimer l'entrée de la Map

Aucun changement de schéma. Données disponibles immédiatement.

---

## 2. Inadéquation architecturale — Détection d'ambiguïté (Phase 3) ⚠️ Limitation connue

**Statut plan** : partiellement prévu — le plan implémente une version simplifiée
du système à 4 modules décrit dans le blog (article URL 1).

**Problème réel** : ce n'est pas un bug de filtre, c'est une inadéquation architecturale
entre ce que le blog visait et ce qui a été implémenté.

Le blog a analysé **90 jours de prompts utilisateur** (texte soumis par l'humain à
l'IA). Le filtre `text.length < 30` a été validé sur ces données : 54% des prompts
problématiques avaient moins de 30 caractères. C'est une règle calibrée sur l'entrée
humain → IA.

Notre implémentation accroche le hook sur **PreToolUse**, qui intercepte les commandes
que l'IA envoie aux outils (bash, lecture de fichiers). Ce sont des inputs
fondamentalement différents. `docker-compose ps` n'est pas un prompt ambigu — c'est
une décision que l'IA a déjà prise. Les faux positifs ne sont pas un problème de
calibration : ils révèlent que le point d'interception est erroné.

**Pipeline complet du blog** (non implémenté) :
1. Module 1 — Détection heuristique (règles + longueur) ← nous avons ça
2. Module 2 — Recherche vectorielle pgvector (sessions similaires passées)
3. Module 3 — Enrichissement RAG (données historiques, paires QA)
4. Module 4 — LLM local Qwen3:4b / Ollama ← nous avons Haiku à la place

**Ce que nous avons** : Module 1 + version simplifiée du Module 4 (Haiku via API),
avec le mauvais point d'interception (commandes IA plutôt que prompts utilisateur).

**À ne pas corriger à la légère** : le bon fix n'est pas un patch de 5 lignes.
Il requiert soit de déplacer la détection côté prompt utilisateur (SessionStart ou
interface en amont), soit d'accepter cette limitation et de documenter que la table
`ambiguities` capture actuellement des faux positifs sur les commandes courtes.

---

## 3. `kpi_snapshots` jamais alimentée ✅ Corriger

**Statut plan** : prévu — table créée en Phase 1 (§1.2), alimentation non spécifiée.
Le plan mentionnait "populated by a cron or end-of-session trigger" sans l'implémenter.
L'article observabilité (URL 10) confirme que les snapshots quotidiens mis à jour
automatiquement en fin de session sont une composante essentielle de l'architecture.

**Écart** : la table existe avec le bon schéma mais zéro ligne.

**Impact** : analyse de tendances impossible. On peut requêter `sessions` directement
mais sans historique agrégé.

**Proposition** : trigger PostgreSQL sur `sessions.ended_at`, sans cron externe.

```sql
CREATE OR REPLACE FUNCTION upsert_kpi_snapshot() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO kpi_snapshots (snapshot_date, total_sessions, avg_input_tokens,
                             cache_hit_rate, waste_rate)
  SELECT
    CURRENT_DATE,
    COUNT(*),
    ROUND(AVG(input_tokens)),
    ROUND(AVG(cache_read_tokens::numeric /
          NULLIF(input_tokens + cache_read_tokens, 0)) * 100, 2),
    ROUND(AVG(CASE WHEN output_tokens = 0 THEN 1 ELSE 0 END) * 100, 2)
  FROM sessions
  WHERE DATE(ended_at) = CURRENT_DATE AND ended_at IS NOT NULL
  ON CONFLICT (snapshot_date) DO UPDATE SET
    total_sessions   = EXCLUDED.total_sessions,
    avg_input_tokens = EXCLUDED.avg_input_tokens,
    cache_hit_rate   = EXCLUDED.cache_hit_rate,
    waste_rate       = EXCLUDED.waste_rate;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refresh_kpi_on_session_stop
  AFTER UPDATE OF ended_at ON sessions
  FOR EACH ROW WHEN (NEW.ended_at IS NOT NULL)
  EXECUTE FUNCTION upsert_kpi_snapshot();
```

Migration : `infra/db/004_kpi_trigger.sql`. Aucune dépendance externe.

---

## 4. Docker Compose — clarification ✅ Aucune action requise

**Statut plan** : prévu — Docker Compose est le mode de déploiement PostgreSQL spécifié.

**Situation réelle** : dans cet environnement WSL2, le daemon Docker n'est pas démarré.
PostgreSQL tourne en natif sur le host. Les commandes `psql` se connectent à ce
PostgreSQL natif, **pas à un container**.

**Le setup est pourtant reproductible** : le `docker-compose.yml` monte déjà
`./infra/db:/docker-entrypoint-initdb.d`. Sur une nouvelle machine avec Docker actif,
`docker compose up -d` appliquera automatiquement les trois migrations SQL au premier
démarrage. Aucun changement de code n'est nécessaire.

**Seule action requise sur cette machine** : démarrer Docker si on veut l'utiliser.
```bash
sudo service docker start   # WSL2 + Docker Engine
# ou activer l'intégration WSL2 dans Docker Desktop (Windows)
```

PostgreSQL natif et Docker Compose sont deux chemins vers le même résultat.
Le code de connexion (`postgresql://claude:claude@localhost:5432/claude_system`)
fonctionne dans les deux cas.

---

## Résumé

| # | Observation | Dans le plan ? | Statut | Action |
|---|-------------|---------------|--------|--------|
| 1 | duration_ms NULL | Oui (source manquante) | Bug implémentation | Corriger (timers in-memory) |
| 2 | Faux positifs ambiguïté | Partiellement | Limitation architecturale | Documenter, pas patcher |
| 3 | kpi_snapshots vide | Oui (non implémenté) | Tâche oubliée | Corriger (trigger SQL) |
| 4 | Docker non démarré | Oui (écart environnement) | Pas un problème | Aucune action requise |
