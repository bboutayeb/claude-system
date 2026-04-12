-- Étape 2 : logger tous les prompts (pas seulement les ambigus)
CREATE TABLE prompts (
  id           SERIAL PRIMARY KEY,
  session_id   TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_text  TEXT NOT NULL,
  char_length  INTEGER GENERATED ALWAYS AS (length(prompt_text)) STORED,
  is_ambiguous BOOLEAN DEFAULT false,
  quality_score NUMERIC,              -- null pour l'instant, rempli plus tard
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX prompts_session_idx ON prompts(session_id);
CREATE INDEX prompts_created_idx ON prompts(created_at);
