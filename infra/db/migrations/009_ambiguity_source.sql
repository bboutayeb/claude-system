-- 009_ambiguity_source.sql
-- Add source column to ambiguities to distinguish AI vs heuristic detections

ALTER TABLE ambiguities ADD COLUMN IF NOT EXISTS source TEXT;

-- Backfill from the prefix already encoded in the suggestion column
UPDATE ambiguities
SET source = CASE
  WHEN suggestion LIKE '[IA]%' THEN 'ia'
  WHEN suggestion LIKE '[heuristique]%' THEN 'heuristique'
  ELSE NULL
END
WHERE source IS NULL;
