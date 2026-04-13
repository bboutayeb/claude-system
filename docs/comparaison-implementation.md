# Comparaison — Notre implémentation vs. philosophie de l'auteur

*Document préparé le 2026-04-13 pour orienter l'échange avec l'auteur du blog.*

---

## Contexte

L'auteur a résumé sa philosophie :

> "Avant de pouvoir gérer un monitoring, il faut collecter des métriques, c'est là qu'interviennent les hooks, qui vont collecter les informations à chaque action dans le système et les mettre dans une base de données."

Ce document compare cet énoncé fondamental avec notre état actuel, identifie les convergences, les divergences, et formule les questions les plus utiles à lui poser.

---

## Vue d'ensemble — Tableau synthétique

| Composant | Philosophie auteur | Notre implémentation | Statut |
|---|---|---|---|
| Collecte via hooks | Hooks → métriques | 4 hooks unifiés dans un binaire | ✅ Aligné |
| Persistance DB | Base de données | PostgreSQL 17 (Docker), 6 tables | ✅ Aligné + enrichi |
| Monitoring | Après collecte | Dashboard Chart.js + routes JSON | ✅ Réalisé |
| Qualité des prompts | (non évoqué) | Quality scorer via Haiku + transcripts | ✅ Au-delà |
| Détection d'ambiguïté | (non évoqué) | Haiku LLM + heuristiques, bloque prompt | ✅ Au-delà |
| Vérification de tâches | (non évoqué) | Verifier avec 5 types de critères SQL/fichier | ✅ Au-delà |
| Distribution | (non évoqué) | Binaire Bun compilé, install/uninstall atomique | ✅ Au-delà |
| RAG / embeddings | (non évoqué) | Non implémenté (Phase 3 roadmap) | ⬜ Futur |

---

## Partie 1 — Analyse détaillée

### 1.1 Collecte via hooks — ✅ Convergence totale

**Philosophie auteur** : les hooks Claude Code capturent les événements du cycle de vie et alimentent une DB.

**Notre implémentation** :
- 5 événements capturés : `SessionStart`, `SessionStop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`
- Gestionnaire unique : `src/hooks/handler.ts` (remplace 4 scripts shell)
- Pattern : hook → HTTP fire-and-forget → serveur persistant → PostgreSQL
- Avantage clé : le serveur HTTP reste en vie entre les sessions (évite 230ms de cold-start par tool call)

```
Claude Code hook event
  → claude-monitor hook <event>  (binaire)
  → POST http://127.0.0.1:18766/<route>
  → handleXxx() → INSERT INTO ...
```

**Question utile à poser à l'auteur** : *Votre implémentation utilise-t-elle des scripts shell qui appellent directement la DB, ou un serveur intermédiaire ?*

---

### 1.2 Base de données — ✅ Aligné, schéma enrichi

**Philosophie auteur** : stocker les métriques en DB après chaque action.

**Notre schéma (6 tables)** :

| Table | Contenu |
|---|---|
| `sessions` | model, source, agent_type, transcript_path, tokens, durée |
| `tool_calls` | tool_name, duration_ms, session_id |
| `prompts` | prompt_text, is_ambiguous, quality_score, char_length |
| `ambiguities` | Prompts ambigus bloqués + suggestion |
| `tasks` | Tâches avec acceptance criteria (JSONB) |
| `kpi_snapshots` | Agrégats journaliers (trigger SQL sur session stop) |

**Point fort** : les KPIs sont calculés automatiquement par un trigger PostgreSQL à chaque fin de session — aucun job batch nécessaire.

**Question utile** : *Calculez-vous vos métriques à la volée (requêtes) ou via des snapshots pré-agrégés ? Notre trigger sur `ended_at` fonctionne bien, mais un batch nocturne serait peut-être plus robuste.*

---

### 1.3 Monitoring (dashboard) — ✅ Réalisé

**Philosophie auteur** : le monitoring vient après la collecte.

**Notre dashboard** :
- Route JSON : `GET /dashboard/kpis?days=7` → `kpi_snapshots`
- Route JSON : `GET /dashboard/tools?days=7` → agrégation `tool_calls`
- Route JSON : `GET /dashboard/prompts?days=7` → agrégation `prompts`
- Frontend : `public/dashboard.html` (Chart.js, dark mode, sélecteur de fenêtre)

**Charts disponibles** :
- `estimated_cost_usd` par jour (ligne)
- `cache_hit_rate` par jour (ligne)
- `ambiguity_rate` par jour (ligne)
- Top outils par fréquence (barres)
- Compteurs du jour (sessions, tokens, coût)

---

### 1.4 Ce que nous avons fait au-delà

#### Quality scoring des prompts
- Agent `src/agents/quality-scorer.ts`
- Lit les transcripts JSONL (sessions terminées)
- Trouve la paire prompt→réponse dans le JSONL
- Appelle Haiku : "Rate this exchange 0-10"
- Met à jour `prompts.quality_score`
- Prérequis pour la Phase 3 (RAG)

#### Détection d'ambiguïté en temps réel
- Hook `UserPromptSubmit` → analyse du prompt
- Heuristiques (longueur < 30 chars, pronoms déictiques)
- Confirmation Haiku si heuristique positive (timeout 400ms)
- Si ambigu : response `{decision: "block", reason: "..."}`  → Claude Code demande clarification

#### Vérificateur de tâches
- Agent `src/agents/verifier.ts` (déclenché toutes les 6h)
- 5 types de critères : `sql_count`, `pattern`, `file_exists`, `no_error`, `heuristic`
- Lit les tâches `pending_review` dans la DB, vérifie les critères, passe à `verified`

#### Binaire distribuable
- Compilé : `bun build --compile` → linux-x64, darwin-arm64
- `claude-monitor install` : setup Docker PG + merge atomique dans `~/.claude/settings.json`
- `claude-monitor uninstall` : nettoyage propre

---

## Partie 2 — Ce qui manque (Phase 3)

### pgvector + RAG — ⬜ Non implémenté

**Objectif** : au moment d'un nouveau prompt, retrouver des prompts historiques similaires avec un faible quality_score et injecter un avertissement.

**Bloquant actuel** : besoin de ≥ 200 `quality_score` remplis avant que la recherche de similarité soit statistiquement utile.

**Pipeline prévu** :
```
Prompt entrant
  → embedding (bge-m3 via Ollama ou text-embedding-3-small)
  → SELECT ... ORDER BY embedding <=> $query_vector LIMIT 3
  → Si score < 4 ET distance cosine < 0.15 :
      injecter "Des prompts similaires ont produit de mauvaises réponses : préciser X"
```

**Migration à créer** :
```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE prompts ADD COLUMN embedding vector(1024);
CREATE INDEX prompts_embedding_idx ON prompts USING hnsw (embedding vector_cosine_ops);
```

**Question utile à poser à l'auteur** : *Avez-vous expérimenté le RAG sur les historiques de prompts ? Quel modèle d'embedding recommandez-vous pour du code/CLI en français+anglais ?*

---

## Partie 3 — Questions prioritaires pour l'auteur

Classées par utilité décroissante :

### Questions architecturales

1. **Structure des hooks** : vos hooks appellent-ils directement la DB ou passent-ils par un serveur HTTP intermédiaire ? Notre pattern serveur persistant est-il proche de ce que vous faites, ou avez-vous un pattern différent ?

2. **Format des payloads** : les payloads Claude Code que vous capturez (SessionStart, PreToolUse, etc.) — sont-ils identiques à ce que vous attendiez, ou avez-vous eu des surprises sur certains champs ?

3. **Agrégation des tokens** : nous agrégerons les tokens depuis le transcript JSONL au moment de `SessionStop` (`aggregateTranscriptTokens`). Est-ce votre approche ? Y a-t-il des cas edge où le transcript n'est pas complet à ce moment ?

### Questions sur la qualité

4. **Quality scoring** : avez-vous un mécanisme de scoring des paires prompt→réponse ? Si oui, via LLM (Haiku) ou heuristiques pures ?

5. **Seuil de déclenchement du RAG** : votre critère pour activer la recherche de similarité est-il basé sur un volume de données ou sur un autre signal ?

### Questions sur ce qui ne fonctionne pas comme prévu

6. **Ambiguity detection** : notre détection bloque certains prompts légitimes (faux positifs). Avez-vous affiné vos heuristiques ? Comment gérez-vous les faux positifs ?

7. **Transcript_path** : le champ `transcript_path` dans les payloads hooks — est-il toujours fiable ? Avons-nous raison de capturer dans les deux handlers Start et Stop par défensive ?

---

## Résumé en 5 bullets

- **Convergence totale** sur la philosophie fondamentale : hooks → DB → monitoring
- **Nous avons un serveur HTTP persistant** (vs. scripts shell directs) — avantage performance pour les hooks fréquents
- **Nous allons plus loin** : quality scoring, ambiguity detection, verifier, binaire distribuable — fonctionnalités que l'auteur n'a probablement pas (ou pas publié)
- **Phase 3 RAG manquante** — la seule vraie lacune par rapport à notre roadmap, intentionnellement différée (besoin de données)
- **Les questions les plus utiles** pour l'auteur portent sur la structure des hooks et le quality scoring, pas sur l'architecture DB (que nous maîtrisons)
