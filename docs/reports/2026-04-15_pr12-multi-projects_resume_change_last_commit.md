Le binaire est opérationnel. Résumé de ce qui a été fait :

  ---
  Changements dans src/routes/user-prompt.ts (commits d830c74 + correctif suivant) :

  1. 3 triggers EN supprimés : pronoms (this/that/it/them...), action verbs (redo/undo/revert/retry), et
  "the changes/suggestions/recommendations" — trop communs en anglais technique, non validés par l'article source.
  Note : d830c74 n'avait supprimé que 2 des 3 (redo/undo/revert gardés par erreur) ; corrigé dans le commit suivant.
  2. Fix regex ça : \bça\b est du code mort en JS (ç est \W, \b ne fire pas) — remplacé par lookaround ASCII
  3. Seuil simplifié : 3 paliers inventés → seuil unique < 30 chars (aligné avec l'article)
  4. Fallback bilingue : détection FR/EN par accents + mots outils → message anglais pour les utilisateurs EN
  5. Contexte Haiku enrichi : récupère le dernier prompt clair de la session avant d'appeler Haiku (reproduit
  l'étape RAG de l'article)
  6. Budget troncature Haiku corrigé : overhead textuel (42 chars) comptabilisé dans le magic number (50 → 92)

  Impact mesuré (après correctif complet) :
  - FP anglais : 75-83% → ~0% (plus aucun trigger EN)
  - FP français : 0% (inchangé)
  - Vrais positifs courts (< 30 chars) : 100% (inchangé)
  - Vrais positifs FR déictiques : 100% (inchangé, + ça maintenant détecté)

  Ce qui reste : le binaire est déployé et le serveur tourne. Les modules pgvector/RAG (articles modules 2-3) sont
  reportés à la v2 — voir docs/reports/2026-04-16_etat-des-lieux-ambiguity-pipeline.md pour la roadmap complète.
