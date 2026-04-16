-- Index partiel composite pour le lookup de contexte dans getSuggestion() :
-- SELECT prompt_text FROM prompts WHERE session_id = $1 AND NOT is_ambiguous ORDER BY created_at DESC LIMIT 1
-- Sans cet index, Postgres trie toutes les lignes de la session (O(n log n)).
-- Avec cet index, le lookup est O(log n) via index-scan sur les seuls prompts clairs.
CREATE INDEX IF NOT EXISTS prompts_session_clear_idx
  ON prompts (session_id, created_at DESC)
  WHERE is_ambiguous = false;
