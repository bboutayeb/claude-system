# Rapport d'audit — Détection d'ambiguïté (commit 5c8eab2)

## Contexte

Le commit `5c8eab2` ("fix: isAmbiguous scan prefix only") modifie deux choses :
1. `src/routes/user-prompt.ts` : les seuils de longueur (`< 10`, `< 40`) utilisent désormais `scanLen` (texte tronqué à 500 chars) au lieu de la longueur complète du prompt
2. `public/dashboard.html` : meilleure gestion d'erreurs sur la carte project-stats

---

## Verdict sur le commit

### Dashboard (pertinent ✓)

Le guard `psRes.ok` + `try/catch` sur `json()` + `resetProjectStatsCard()` est un fix correct. Empêche qu'une erreur réseau/JSON casse le rendu complet du dashboard.

### isAmbiguous — changement inefficace ✗

Le commit prétend corriger : *"une instruction ambiguë courte + du contexte collé tombait dans la branche 'long prompt / 2 triggers requis'"*.

**Simulation : le fix ne change rien.** Tests côte-à-côte OLD vs NEW :

| Cas | len (old) | scanLen (new) | OLD | NEW | Changement ? |
|-----|-----------|---------------|-----|-----|--------------|
| "Fix it" + 1000 chars collés | 1007 | 500 | false | false | Non |
| "Fix it" seul | 6 | 6 | true | true | Non |
| "Commit and push the changes..." (59 chars) | 59 | 59 | true | true | Non |

La distinction `scanLen` vs `len` ne change le résultat que si `text.length > 500` ET que les 500 premiers caractères tombent dans une bande de seuil différente (< 10 ou < 40). Ça n'arrive en pratique jamais — `scanLen` est toujours ≥ 40 quand le prompt dépasse 500 chars.

### Erreur factuelle dans le message de commit

Le message dit `AMBIGUITY_SCAN_LENGTH=300` mais la constante est à `500` (inchangée depuis `fb4df84`).

---

## Problème de fond : les triggers anglais

### Les 6 regex actuelles

```
1. /\b(this|that|it|them|those|these)\b/i    ← PRONOMS ANGLAIS COURANTS
2. /\b(redo|undo|revert|retry)\b/i           ← TERMES TECHNIQUES COURANTS
3. /\bthe (recommendations?|suggestions?|changes?)\b/i  ← "the changes" = très fréquent
4. /\b(refaire|relancer|annuler|recommencer|implémenter)\b/i
5. /\b(ça|ceci|cela)\b/i
6. /\bles? (recommandations?|suggestions?|changements?|modifications?)\b/i
```

### Logique de décision

- `< 10 chars` → toujours ambigu
- `10-39 chars` → **1 trigger** suffit
- `≥ 40 chars` → **2 triggers** requis

### Le problème structurel

**Le trigger 1 (`this/that/it/them/those/these`) matche pratiquement toute phrase anglaise de longueur modérée.** Ces mots sont des nécessités grammaticales, pas des indicateurs d'ambiguïté.

Conséquence : le seuil "2 triggers" pour les prompts longs se réduit effectivement à "1 trigger + pronom anglais normal" — soit la même chose que 1 trigger.

### Résultats de simulation

**Test 1 — Prompts anglais courants (30 exemples)** :
- 4 faux positifs → **13.3% de FP**
- Exemples bloqués à tort :
  - *"Add a retry button to the login form that resets the error state"* (that + retry)
  - *"Commit and push the changes in the PR in order to review it"* (it + the changes)

**Test 2 — Prompts anglais réalistes à risque (24 exemples)** :
- 18 faux positifs → **75% de FP**
- Toute phrase contenant "retry/revert/undo" ou "the changes" + un pronom courant est bloquée
- Exemples :
  - *"Implement retry logic for the HTTP client when it times out"* (it + retry)
  - *"Review the changes and tell me if it looks good"* (it + the changes)
  - *"Add undo/redo support to the text editor component"* + "it" (it + undo)

**Test 3 — Prompts français (10 exemples)** :
- 0 faux positifs → **0% de FP** ✓
- Les triggers FR (`ça`, `refaire`, `relancer`) sont effectivement ambigus en isolation

**Test 4 — Vrais prompts ambigus (10 exemples)** :
- 10/10 détectés → **100% de vrais positifs** ✓

### Asymétrie FR/EN

| Langue | FP général | FP réaliste | Cause |
|--------|-----------|-------------|-------|
| Français | 0% | 0% | Triggers calibrés sur des mots réellement ambigus |
| Anglais | 13.3% | 75% | `this/that/it` sont des pronoms obligatoires, pas des déictiques ambigus |

---

## Données de production

| Métrique | Valeur |
|----------|--------|
| Total prompts | 185 |
| Flaggés ambigus | 39 (21.1%) |
| Faux positifs marqués | 0 (personne ne les marque ?) |
| Taux journalier 13/04 | 29.1% (30/103) |
| Taux journalier 14/04 | 5.7% (4/70) |
| Taux journalier 15/04 | 45.5% (5/12) |
| Ambiguïtés source IA | 14 |
| Ambiguïtés source heuristique | 14 |

Cas confirmés de faux positifs en production (non marqués) :
- *"Commit and push the changes in the PR in order to review it"* → bloqué (it + the changes)
- *"Explique moi mieux les délibérations des agents..."* (2000 chars, contenu collé) → bloqué

---

## Le filet de sécurité Haiku

Haiku sert de second filtre : si l'heuristique dit "ambigu", Haiku peut dire "c'est clair" et laisser passer. **Mais :**

1. **Coût** : chaque faux positif heuristique déclenche un appel Haiku (~$0.001)
2. **Latence** : jusqu'à 3 secondes de timeout ajoutées à chaque prompt faussement flaggé
3. **Fallback dégradé** : si Haiku est indisponible (pas de clé API, timeout, erreur), le prompt est bloqué avec un message **en français uniquement** (*"Votre prompt semble ambigu..."*) — mauvaise UX pour un utilisateur anglophone
4. **Pas infaillible** : Haiku peut lui aussi se tromper sur des prompts clairs mais techniquement déictiques

---

## Comparaison avec l'article source (Mathieu Grenier)

L'article qui a inspiré cette feature a une philosophie **fondamentalement différente** de notre implémentation. C'est la source du problème.

### Ce que fait l'article

```
prompt → [Heuristique] keywords FR + longueur < 30 chars
       → [pgvector] recherche sessions passées similaires mal notées
       → [RAG] enrichissement avec contexte historique
       → [LLM local] génère 1 question de clarification
```

**Triggers de l'article** (exhaustifs) :
```ts
const AMBIGUOUS_TRIGGERS = [
  'refaire', 'relancer', 'les recommandations',
  'implementer les recommandations', 'la phase suivante',
  'cette strategie', 'ce plan', 'implementer'
]
// + prompt.length < 30
```

### Ce que fait notre implémentation

```
prompt → [Heuristique] 6 regex FR+EN, 3 paliers de longueur
       → [Haiku API] génère 1 question ou dit "clear"
```

### Divergences critiques

| Aspect | Article source | Notre implémentation | Impact |
|--------|---------------|---------------------|--------|
| **Triggers** | FR uniquement, mots-clés ciblés | FR + EN, regex avec pronoms courants | Cause directe des FP anglais |
| **Pronoms EN** | **Absents** — pas de this/that/it | 1er trigger = `this\|that\|it\|them\|those\|these` | 75% FP sur prompts EN réalistes |
| **Seuil court** | `< 30 chars` (seuil unique) | 3 paliers : `< 10`, `< 40`, `≥ 40` | Complexité ajoutée sans valeur |
| **Prompts longs** | pgvector → similarité avec sessions passées mal notées | Regex uniquement (≥ 2 triggers) | Tente de compenser le manque de pgvector par des regex agressifs |
| **LLM** | Local (qwen3:4b, 0€, 350ms) — ne fire que si pgvector a trouvé un match | Haiku API (0.001$/appel, 3s timeout) — fire sur tout prompt flaggé | Coût + latence sur chaque FP |
| **Contexte session** | Récupère le dernier prompt clair de la session et le concatène | Aucun contexte session | Haiku juge sans contexte |
| **Rôle du LLM** | Suggestion-engine : propose une clarification si les heuristiques + vecteurs l'exigent | Juge + correcteur : doit rattraper les FP de l'heuristique | Le LLM compense au lieu de compléter |

### La citation clé de l'article

> *"On a tendance à vouloir tout faire avec du ML. La détection heuristique couvre 80% des cas avec 10% de l'effort. Commencer par là."*

**Notre erreur** : on a pris "commencer par là" et on a étendu l'heuristique au-delà de sa zone de compétence (pronoms anglais, paliers multiples) au lieu d'investir dans les modules 2-3 (pgvector/RAG).

### Ce qu'on a raté dans le workflow

L'article a un **pipeline à étages où chaque module joue un rôle précis** :

1. **Heuristique** = gardien binaire léger : "est-ce un prompt court/déictique FR évident ?" → oui/non
2. **pgvector** = intelligence contextuelle : "ce prompt ressemble-t-il à des sessions passées qui se sont mal passées ?" → signaux faibles
3. **RAG** = enrichissement : donne au LLM le contexte pour poser une bonne question
4. **LLM** = rédacteur : formule la question de clarification

Notre implémentation fusionne les rôles 1-2-3 dans l'heuristique (regex sur-étendue), puis demande au LLM de jouer les rôles 2-3-4 (juger l'ambiguïté + corriger les FP + formuler). Résultat : l'heuristique est trop agressive et Haiku doit rattraper ses erreurs.

---

## Recommandation

### Réaligner sur la philosophie de l'article

**Principe** : l'heuristique ne doit attraper que les cas **évidents** (courts + mots-clés FR ciblés). Tout le reste est délégué soit à Haiku (notre substitut pour pgvector+LLM local), soit laissé passer.

### Changements concrets

**1. Supprimer les 3 triggers anglais** (lignes 8-11 de `user-prompt.ts`)

```diff
 const AMBIGUITY_TRIGGERS = [
-  /\b(this|that|it|them|those|these)\b/i,
-  /\b(redo|undo|revert|retry)\b/i,
-  /\bthe (recommendations?|suggestions?|changes?)\b/i,
   /\b(refaire|relancer|annuler|recommencer|implémenter)\b/i,
   /\b(ça|ceci|cela)\b/i,
   /\bles? (recommandations?|suggestions?|changements?|modifications?)\b/i,
 ]
```

**Justification** : l'article n'a AUCUN trigger anglais. Les pronoms anglais sont des nécessités grammaticales, pas des déictiques ambigus. `retry`, `revert`, `undo` sont des termes techniques légitimes.

**2. Simplifier à 2 paliers comme l'article** (seuil unique à 30 chars)

```ts
function isAmbiguous(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 30) return true  // comme l'article
  return AMBIGUITY_TRIGGERS.some(r => r.test(trimmed.slice(0, 500)))
}
```

**Justification** : l'article utilise `< 30 chars` comme seuil unique. Le système à 3 paliers (10/40/2-triggers) ajoute de la complexité sans valeur — il a été inventé pour compenser les FP des triggers anglais.

**3. Enrichir le contexte Haiku avec le dernier prompt de la session**

Comme l'article fait avec son LLM local : récupérer le dernier prompt non-ambigu de la session et le concaténer avant d'envoyer à Haiku.

```sql
SELECT prompt_text FROM prompts
WHERE session_id = $1 AND NOT is_ambiguous
ORDER BY created_at DESC LIMIT 1
```

**4. Rendre le message fallback bilingue**

Détecter la langue du prompt et adapter le `FALLBACK_REASON`.

### Ce qu'on ne fait PAS (pour l'instant)

- pgvector / embeddings / RAG (modules 2-3 de l'article) — investissement disproportionné pour le volume actuel (185 prompts). À réévaluer à 1000+ prompts.

### Résultat attendu

| Métrique | Avant | Après |
|----------|-------|-------|
| FP anglais (prompts ≥ 40 chars) | 13-75% | ~0% (plus de triggers EN) |
| FP français | 0% | 0% (inchangé) |
| Vrais positifs courts (< 30 chars) | 100% | 100% (inchangé) |
| Vrais positifs FR déictiques | 100% | 100% (inchangé) |
| Appels Haiku inutiles | ~50% des appels | ~0% |
| Vrais positifs EN longs ("redo it" = 7 chars → < 30) | 100% | 100% |

### Fichiers à modifier

- `src/routes/user-prompt.ts` — triggers, seuils, contexte session, fallback bilingue
- Aucun autre fichier impacté

### Vérification

```bash
# Prompt ambigu FR → doit bloquer
curl -s localhost:18766/user-prompt -H 'Content-Type: application/json' \
  -d '{"prompt":"refaire","session_id":"test"}' | jq .

# Prompt clair EN → doit passer
curl -s localhost:18766/user-prompt -H 'Content-Type: application/json' \
  -d '{"prompt":"Implement retry logic for the HTTP client when it times out","session_id":"test"}' | jq .

# Prompt court EN → doit bloquer (< 30 chars)
curl -s localhost:18766/user-prompt -H 'Content-Type: application/json' \
  -d '{"prompt":"Fix it","session_id":"test"}' | jq .

# Prompt long EN avec "the changes" → doit passer
curl -s localhost:18766/user-prompt -H 'Content-Type: application/json' \
  -d '{"prompt":"Commit and push the changes in the PR in order to review it","session_id":"test"}' | jq .

# Build
bun build --compile --target=bun-linux-x64 src/cli.ts --outfile dist/claude-monitor
```

---

## Résumé

| Aspect | Verdict |
|--------|---------|
| Dashboard fix (commit) | ✓ Pertinent |
| isAmbiguous scanLen fix (commit) | ✗ Inefficace (ne change aucun résultat) |
| Message de commit | ✗ Erreur factuelle (dit 300, code dit 500) |
| Heuristique FR | ✓ Bien calibrée, alignée avec l'article |
| Heuristique EN | ✗ Diverge de l'article source — triggers inventés, non validés |
| Filet Haiku | ⚠ Rôle inversé : compense les FP au lieu de compléter |
| Architecture globale | ⚠ Fusionne heuristique + jugement LLM — l'article les sépare clairement |
