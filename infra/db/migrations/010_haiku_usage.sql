-- Migration 010 : haiku_usage table
-- Tracks every Haiku API call (ambiguity detection + quality scoring)

CREATE TABLE IF NOT EXISTS haiku_usage (
  id         SERIAL PRIMARY KEY,
  source     TEXT NOT NULL CHECK (source IN ('ambiguity', 'scoring')),
  input_tokens  INT NOT NULL,
  output_tokens INT NOT NULL,
  cost_usd   NUMERIC(12, 8) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
