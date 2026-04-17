# Pipeline ambiguïté — Edge case A2 : `ça` avec référent intra-phrase

**Date :** 2026-04-17
**Contexte :** Observation post-déploiement du fix A2 (commit `d68943c`, 2026-04-16 12:34 +0200).
**Rapports précédents :** [`2026-04-16_ambiguity-pipeline-direction-a2.md`](./2026-04-16_ambiguity-pipeline-direction-a2.md), [`2026-04-16_etat-des-lieux-ambiguity-pipeline.md`](./2026-04-16_etat-des-lieux-ambiguity-pipeline.md)

---

## 1. Observation

Le matin du 17/04, deux prompts consécutifs ont été bloqués par l'heuristique A2 (session `f1b2239e-cfc8-48f3-bd41-48029370b120`) :

| Heure (UTC) | Prompt | Question IA rendue |
|-------------|--------|--------------------|
| 09:49:41 | *"Lis les commentaires fait en PR par Copilot et fix **ça**."* | *Quels fichiers ou PR spécifiques dois-je vérifier pour les commentaires de Copilot ?* |
| 09:50:07 | *"Lis juste les deux derniers commentaires fait en PR 12 par Copilot et fix **ça**."* | *Êtes-vous en train de me demander de lister les commentaires d'une vraie PR numéro 12 dans votre projet ?* |

Les deux blocks ne figurent pas dans la table `ambiguities` — la DB Postgres (Docker) était arrêtée ce matin-là ; les INSERT silencieux (`.catch(() => {})`) ont absorbé l'échec. Source de vérité : transcript Claude Code `~/.claude/projects/-home-zaibaker-Code-Perso-IA-prompt/f1b2239e-*.jsonl`.

### Remarque de diagnostic

Une confusion initiale a fait croire que les blocks provenaient d'une régression d'A2 : le copier-coller dans la conversation contenait les 5 prompts *"continue avec les modifications..."*. Vérification DB : ces 5 prompts-là sont enregistrés **le 16/04 à 10:59-11:01** (texte + suggestion identiques), soit les évènements qui ont *motivé* l'écriture d'A2 — pas des blocks récents.

---

## 2. Cause

Le trigger A2 en vigueur :

```ts
/(?<![a-zA-Z0-9_])(ça|ceci|cela)(?![a-zA-Z0-9_])/i
```

matche *"fix **ça**."* — l'espace qui précède et le point qui suit passent les lookarounds ASCII. C'est le comportement documenté dans A2 §3 :

> | `ça/ceci/cela` | Ambigu par construction ? **Oui** — déictique pur, aucun référent syntaxique | Valide ✓ |

---

## 3. Révision du principe A2

Le principe énoncé dans A2 § 3 est :

> *Un trigger heuristique n'est valide que s'il détecte une ambiguïté indépendante du contexte de session.*

Avec en corollaire que `ça/ceci/cela` seraient des "déictiques purs, aucun référent syntaxique". Les deux prompts du 17/04 contredisent ce corollaire : *"les commentaires ... fix ça"* contient un référent **intra-phrase** clair (les commentaires Copilot). L'ambiguïté n'est donc plus "indépendante du contexte" — elle est résolue par la phrase elle-même.

**Formulation corrigée du principe :** un déictique peut avoir une portée anaphorique *locale* (même phrase, paragraphe adjacent) tout en restant formellement un déictique. La regex actuelle ne distingue pas ces deux régimes.

---

## 4. Décision : garder le trigger, accepter l'edge case

Plutôt que de retirer `ça/ceci/cela` de la heuristique, on conserve le trigger. Raisons :

1. **Haiku filtre partiellement les FP.** Sur les 2 blocks du 17/04, la question IA du 09:49 (*"Quels fichiers ou PR spécifiques ?"*) est une clarification **légitime** — le prompt mentionnait "PR" sans numéro. Seule la question du 09:50 est un vrai FP (Haiku repose une question non pertinente alors que "PR 12" lève l'ambiguïté). Ratio 50 % de FP réel, pas 100 %.
2. **Retirer `ça` laisserait passer des prompts courts réellement ambigus.** Exemples typiques : *"refais ça"* (10 chars, déjà attrapé par le seuil < 30), mais aussi *"applique ça sur tous les fichiers"* (35 chars, long, attrapé uniquement par la regex). Ce dernier type de prompt a une vraie ambiguïté indépendante du contexte.
3. **Taux marginal.** 2 blocks sur une demi-journée d'usage, aucun n'a introduit de boucle (l'utilisateur a abandonné le flow manuellement après 2 reformulations).

**Ce qu'on renonce à faire côté heuristique :** distinguer l'anaphore intra-phrase de l'anaphore hors-phrase. C'est un problème d'analyse syntaxique que la regex ne peut pas résoudre proprement — tout raffinement de regex ajouterait plus de bruit qu'il n'en enlèverait.

---

## 5. Signal pour la direction B

Ce cas est l'exemple canonique de ce que **pgvector + RAG** résoudraient :

- L'étage 2 (pgvector) calculerait la similarité avec les sessions passées qui contenaient *"fix ça"* et regarderait leur note qualité. Si les sessions similaires ont bien abouti (quality_score élevé), la détection s'arrête là — pas d'appel Haiku, pas de block.
- L'étage 3 (RAG) enrichirait le prompt envoyé à Haiku avec le contexte session (*"l'utilisateur parlait de commentaires Copilot juste avant"*), ce qui ferait répondre Haiku par une chaîne vide (prompt clair) dans la plupart des cas.

**Seuil de déclenchement de la direction B :** atteindre ≥ 1000 prompts avec `quality_score` renseigné (critère déjà posé dans l'état-des-lieux §6). L'edge case `ça` + anaphore intra-phrase rejoint la liste des signaux qui justifieront l'investissement pgvector/RAG quand le volume le permettra.

---

## 6. Action immédiate (non liée au trigger)

Les blocks du 17/04 ne sont pas en DB parce que la DB était arrêtée : l'INSERT `ambiguities` échoue en silence. On améliore la détection **côté infra** (pas côté heuristique) en ajoutant un auto-start de la DB Docker au session-start du hook `claude-monitor`, avec message visible injecté via `hookSpecificOutput.additionalContext`.

Détails d'implémentation : voir plan `je-ne-comprends-pas-curried-dragon.md`.

---

## 7. Résumé

| Aspect | Décision |
|--------|----------|
| Trigger `ça/ceci/cela` | **Conservé** — principe A2 nuancé dans ce document |
| Retrait du trigger | ❌ — casse trop de vrais positifs sur prompts courts |
| Raffinement regex (exclusion anaphore locale) | ❌ — hors de portée d'une regex robuste |
| Amélioration ciblée | ⏭ Direction B (pgvector + RAG) quand volume ≥ 1000 prompts |
| Observabilité DB | ✓ Auto-start DB au session-start (plan séparé) |
