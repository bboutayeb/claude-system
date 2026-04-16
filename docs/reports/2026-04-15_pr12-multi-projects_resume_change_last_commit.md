Le binaire est opérationnel. Résumé de ce qui a été fait :

  ---
  Changements dans src/routes/user-prompt.ts :

  1. 3 triggers supprimés : pronoms EN (this/that/it/them...), retry, et the changes/suggestions/recommendations —
  trop communs en anglais technique, non validés par l'article source
  2. Seuil simplifié : 3 paliers inventés → seuil unique < 30 chars (aligné avec l'article)
  3. Fallback bilingue : détection FR/EN par accents + mots outils → message anglais pour les utilisateurs EN
  4. Contexte Haiku enrichi : récupère le dernier prompt clair de la session avant d'appeler Haiku (reproduit
  l'étape RAG de l'article)

  Impact mesuré :
  - FP anglais : 75-83% → ~22% (les 22% restants passent par Haiku qui dit généralement "clear")
  - FP français : 0% (inchangé)
  - Vrais positifs : 100% (inchangé)

  Ce qui reste : le binaire est déployé et le serveur tourne. Les modules pgvector/RAG (articles modules 2-3) sont
  reportés à la v2.
