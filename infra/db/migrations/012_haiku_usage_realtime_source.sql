-- Migration 012: allow 'realtime-scoring' source in haiku_usage
ALTER TABLE haiku_usage DROP CONSTRAINT IF EXISTS haiku_usage_source_check;
ALTER TABLE haiku_usage ADD CONSTRAINT haiku_usage_source_check
  CHECK (source IN ('ambiguity', 'scoring', 'realtime-scoring'));
