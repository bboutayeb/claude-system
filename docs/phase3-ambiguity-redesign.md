# Phase 3 — Refonte de la détection d'ambiguïté

Date : 2026-04-13
Source : [Article blog — Améliorer les prompts utilisateurs automatiquement](https://mathieugrenier.fr/blog/coder-avec-claude-c-est-facile-et-rapide-1/ameliorer-prompts-utilisateurs-automatiquement-ollama-ambiguite-44)

---

## Rappel du problème

La Phase 3 implémente la détection d'ambiguïté via un hook **PreToolUse**.
Le blog source intercepte les **prompts utilisateur** avant traitement par Claude.
Résultat actuel : faux positifs structurels (commandes shell courtes comme `ls`,
`git status`, `docker ps` détectées à tort comme ambiguës).

---

## Comparaison des deux approches

### Ancienne approche — PreToolUse (actuel)

```
User tape "refaire"
    ↓
Claude interprète → décide d'appeler Bash("pytest")
    ↓
Hook PreToolUse reçoit {"tool_input": {"command": "pytest"}}
    ↓
isAmbiguous("pytest") → true (< 30 chars)
    ↓
Haiku génère "[clarification] Which tests?"
    ↓
echo "[clarification] ..." → stderr (invisible pour Claude)
echo "{}" → stdout → Claude Code continue l'exécution
```

### Nouvelle approche — UserPromptSubmit (proposée)

```
User tape "refaire"
    ↓
Hook UserPromptSubmit reçoit {"prompt": "refaire", "session_id": "..."}
    ↓
isAmbiguous("refaire") → true (< 30 chars + trigger FR "refaire")
    ↓
Haiku génère "Refaire quoi exactement ? Les tests ou la migration ?"
    ↓
{"decision": "block", "reason": "Refaire quoi exactement ?"} → stdout
    ↓
Claude Code BLOQUE → affiche la question → l'utilisateur reformule
```

---

## Tableau comparatif

| Critère | Ancienne (PreToolUse) | Nouvelle (UserPromptSubmit) |
|---------|----------------------|----------------------------|
| **Point d'interception** | Commandes IA → outils | Prompt utilisateur → Claude |
| **Ce qui est analysé** | `tool_input.command` (`ls`, `pytest`) | Texte brut de l'utilisateur (`refaire`, `ça`) |
| **Calibration < 30 chars** | Erronée (commandes shell sont courtes par nature) | Correcte (validée sur 90 jours de prompts, 54% problématiques) |
| **Triggers regex** | Anglais uniquement | Bilingue FR+EN (refaire, relancer, ça, ceci + this, that, redo) |
| **Mécanisme de blocage** | Aucun — `echo "{}"` + `exit 0` systématique | `{"decision":"block","reason":"..."}` — bloque Claude |
| **Visibilité suggestion** | stderr seulement, invisible pour Claude | stdout, affiché à l'utilisateur, Claude ne démarre pas |
| **Moment de l'intervention** | Après que Claude a décidé quoi faire | Avant que Claude commence à réfléchir |
| **Données collectées** | Commandes shell (bruit) | Vrais prompts utilisateur (signal) |
| **Faux positifs attendus** | Élevés (~70% sur commandes shell courtes) | Faibles (aligné sur le seuil blog) |
| **LLM utilisé** | Haiku API (400ms timeout) | Haiku API (400ms timeout) — identique |
| **Fallback si timeout** | Silencieux (continue sans rien faire) | Message générique statique ("Pourriez-vous préciser ?") |
| **Table DB** | `ambiguities` (tool_name = nom de l'outil) | `ambiguities` (tool_name = NULL, prompt = texte user) |

---

## Avantages de la nouvelle approche

1. **Alignement architectural** — intercepte ce que le blog a mesuré (prompts humains),
   pas un proxy inadéquat (commandes IA)

2. **Blocage effectif** — l'utilisateur voit la question de clarification et doit
   reformuler. Aujourd'hui la suggestion disparaît dans stderr sans conséquence

3. **Données exploitables** — la table `ambiguities` contiendra de vrais prompts
   utilisateur, permettant d'analyser les patterns d'ambiguïté réels

4. **Réduction du bruit** — plus de faux positifs sur `docker ps`, `git log`, `ls -la`

5. **Bilingue** — triggers FR+EN adaptés au contexte francophone du projet

6. **Séparation des responsabilités** — PreToolUse ne fait plus que le timer ;
   la détection vit dans son propre hook dédié

---

## Inconvénients / risques

1. **Friction utilisateur** — bloquer un prompt force l'utilisateur à reformuler.
   Si le seuil est mal calibré, ça devient irritant. Mitigation : Haiku peut
   répondre "empty string" pour les prompts courts mais clairs (ex: "oui", "non", "ok")

2. **Latence ajoutée** — le hook `UserPromptSubmit` est synchrone. Si Haiku met
   400ms, l'utilisateur attend 400ms avant que Claude démarre (ou que le block
   s'affiche). Mitigation : timeout 400ms + fallback statique

3. **Dépendance serveur** — si le hooks-server est down, le fallback `{}` laisse
   passer tous les prompts (fail-open). Ce n'est pas un risque fonctionnel mais
   la détection est silencieusement désactivée

4. **Pas de modules 2+3** — sans pgvector ni RAG, on ne peut pas enrichir avec
   le contexte historique. Le blog génère de meilleures clarifications grâce aux
   sessions passées similaires. Notre pipeline reste Module 1 + Module 4 simplifié

5. **Coût Haiku non nul** — le blog utilise Qwen3:4b local (0€). Chaque prompt
   ambigu coûte ~0.001$ via Haiku API. Négligeable mais non nul

---

## Plan d'implémentation

### Fichiers à créer

| Fichier | Rôle |
|---------|------|
| `hooks-server/routes/user-prompt.ts` | Route `/user-prompt` : triggers FR+EN, `isAmbiguous()`, `getSuggestion()` via Haiku, retourne block ou continue |
| `hooks/user-prompt-submit.sh` | Script hook : POST stdin vers serveur, **relaye** la réponse JSON en stdout |

### Fichiers à modifier

| Fichier | Changement |
|---------|-----------|
| `hooks-server/server.ts` | Ajouter import + case `/user-prompt` |
| `.claude/settings.json` | Ajouter entrée `UserPromptSubmit` |
| `hooks-server/routes/pre-tool.ts` | Supprimer toute logique ambiguïté, garder uniquement timer |
| `hooks/pre-tool-use.sh` | Supprimer extraction jq + suggestion stderr, garder POST fire-and-forget |

### Aucun fichier à modifier

| Fichier | Raison |
|---------|--------|
| `infra/db/002_ambiguities.sql` | Schéma compatible (tool_name nullable) |
| `hooks-server/timers.ts` | Inchangé |
| `hooks-server/db.ts` | Inchangé |

### Ordre d'exécution

1. Créer `user-prompt.ts` (nouvelle logique)
2. Mettre à jour `server.ts` (câbler la route)
3. Créer `user-prompt-submit.sh` + `chmod +x`
4. Mettre à jour `.claude/settings.json` (activer le hook)
5. Nettoyer `pre-tool.ts` (supprimer ambiguïté)
6. Simplifier `pre-tool-use.sh` (supprimer code mort)
7. Redémarrer le serveur, tester

### Vérification

```bash
# Prompt ambigu → doit bloquer
curl -X POST localhost:18766/user-prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"refaire","session_id":"test"}'
# Attendu : {"decision":"block","reason":"Refaire quoi exactement ? ..."}

# Prompt clair → doit continuer
curl -X POST localhost:18766/user-prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Ajoute une colonne email NOT NULL à la table users","session_id":"test"}'
# Attendu : {}

# Vérifier les logs
psql -c "SELECT * FROM ambiguities ORDER BY created_at DESC LIMIT 5"
```
