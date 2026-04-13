-- Migration 011: add false_positive column to ambiguities
-- NULL = no feedback yet, true = false positive, false = confirmed ambiguous
ALTER TABLE ambiguities ADD COLUMN IF NOT EXISTS false_positive BOOLEAN DEFAULT NULL;
