# Pipeline ambiguïté — Direction A2 : resserrement des triggers

**Date :** 2026-04-16  
**Contexte :** Suite à une succession de blocages en cascade sur des prompts longs et clairs.  
**Rapport précédent :** [`2026-04-16_etat-des-lieux-ambiguity-pipeline.md`](./2026-04-16_etat-des-lieux-ambiguity-pipeline.md) — snapshot après direction A, à conserver comme référence historique.

---

## 1. Problème observé

Des prompts longs et clairs ont été bloqués 5 fois de suite sans possibilité de sortir de la boucle :

| Heure | Prompt (tronqué) | Résultat |
|-------|-----------------|----------|
| 10:59 | "continue avec les modifications en faisaint un rapport dans @docs/reports/" | BLOCK |
| 11:00 | "continue avec les modifications en faisaint un rapport de ta dernière réponse..." | BLOCK |
| 11:00 | "continue avec les modifications en faisaint un rapport complet de ta dernière réponse..." | BLOCK |
| 11:01 | "Continue avec les modifications en faisaint un insérant un rapport complet..." | BLOCK |
| 11:02 | **"Applique donc le dernier prompt"** (pas de "modifications") | PASS |

---

## 2. Diagnostic — pourquoi la boucle ne se casse pas

### Étape 1 : l'heuristique over-trigger

Le trigger `/\bles? (recommandations?|suggestions?|changements?|modifications?)\b/i` matchait `les modifications` dans tous les prompts. Or ce keyword n'est ambigu qu'en l'absence de contexte de session — contexte auquel l'heuristique n'a pas accès.

### Étape 2 : Haiku ne peut pas casser la boucle

Haiku reçoit pour contexte le **dernier prompt non-ambigu de la session** :

```sql
SELECT prompt_text FROM prompts
WHERE session_id = $1 AND NOT is_ambiguous
ORDER BY created_at DESC LIMIT 1
```

Chaque tentative bloquée est enregistrée `is_ambiguous = true` — donc filtrée. Haiku reçoit à chaque appel le **même vieux contexte**, sans voir les reformulations précédentes. Il rend le même verdict à chaque fois.

### Résumé

```
Prompt "continue avec les modifications..."
    → heuristique : "les modifications" → flag
    → Haiku : voit le prompt isolé + contexte stale → génère une question → BLOCK
    → enregistré is_ambiguous = true
    → reformulation : toujours "les modifications" → même cycle
```

---

## 3. Principe directeur identifié

> **Un trigger heuristique n'est valide que s'il détecte une ambiguïté indépendante du contexte de session.**

L'heuristique est le seul juge dans notre pipeline (pgvector absent). Elle doit donc être conservatrice : ne flagger que ce qui est ambigu par construction.

| Trigger | Ambigu par construction ? | Valide ? |
|---------|--------------------------|----------|
| prompt < 30 chars | Oui — trop court pour être actionable | ✓ |
| `ça/ceci/cela` | Oui — déictique pur, aucun référent syntaxique | ✓ |
| `les recommandations/suggestions` | Oui — quasi-toujours un back-reference sans référent | ✓ |
| `les modifications/changements` | Non — dépend du contexte (git, tâche en cours) | ✗ supprimé |
| `refaire/relancer/annuler/recommencer/implémenter` | Non — ambigu seulement sans objet direct ; sans objet → < 30 chars déjà capturé | ✗ supprimé |

---

## 4. Changement appliqué

**Fichier :** `src/routes/user-prompt.ts`

```diff
 const AMBIGUITY_TRIGGERS = [
-  /\b(refaire|relancer|annuler|recommencer|implémenter)\b/i,
-  /(?<![a-zA-Z0-9_])(ça|ceci|cela)(?![a-zA-Z0-9_])/i,
-  /\bles? (recommandations?|suggestions?|changements?|modifications?)\b/i,
+  // Déictiques purs — ambigus par construction, sans référent syntaxique
+  /(?<![a-zA-Z0-9_])(ça|ceci|cela)(?![a-zA-Z0-9_])/i,
+  // Back-references à une liste passée — quasi-toujours ambigus sans contexte
+  /\bles? (recommandations?|suggestions?)\b/i,
 ]
```

---

## 5. État du pipeline après direction A2

```
UserPromptSubmit
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ÉTAGE 1 — Heuristique (direction A2)                    │
│  Triggers context-free uniquement :                      │
│    • longueur < 30 chars                                 │
│    • ça / ceci / cela  (déictiques purs)                 │
│    • les recommandations / suggestions  (back-refs)      │
│  Si NON → laisser passer (fin du pipeline)               │
│  Si OUI → passer à l'étage 4                             │
└──────────────────────────────────────────────────────────┘
    │ (ambigu avéré)
    ▼
    [ÉTAGE 2 manquant — pgvector]
    [ÉTAGE 3 partiel — dernier prompt clair de session]
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ÉTAGE 4 — Haiku API (rédacteur de question)             │
│  Input : prompt courant + dernier prompt clair session   │
│  Output : 1 question de clarification (max 20 mots)      │
│  Escape : réponse vide → laisser passer                  │
└──────────────────────────────────────────────────────────┘
```

**Statut des étages :**
- ✓ Étage 1 — triggers resserrés sur ambiguïtés context-free
- ✓ Étage 4 — Haiku API fonctionnel, contexte session partiel
- ✗ Étage 2 — absent (pgvector, cf. direction B)
- ✗ Étage 3 — partiel (1 prompt clair, pas de scoring similarité)

---

## 6. Résultats de vérification post-déploiement

```
les modifications (long, contexte clair)    → {}       ✓ passe
les changements git (commit prompt)         → {}       ✓ passe
refaire + objet direct                      → {}       ✓ passe
refaire seul (7 chars < 30)                 → BLOCK    ✓ bloque
applique ça sur tous les fichiers           → BLOCK    ✓ bloque
implémente les recommandations              → BLOCK    ✓ bloque
/compact (slash command)                    → {}       ✓ passe
```

---

## 7. Ce qui reste inchangé pour la direction B

Les sections 3-8 du rapport précédent restent valides. La direction B (pgvector + embeddings) demeure le prochain palier quand le volume atteint ≥ 1000 prompts avec `quality_score` renseigné.

Signal de déclenchement :
```sql
SELECT COUNT(*) FROM prompts WHERE quality_score IS NOT NULL;
```
