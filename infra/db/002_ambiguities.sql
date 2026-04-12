-- Ambiguity detections logged by Phase 3 (Claude Haiku analysis)
CREATE TABLE ambiguities (
  id SERIAL PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT,
  prompt_text TEXT NOT NULL,
  suggestion TEXT,
  detected_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ambiguities_session_idx ON ambiguities(session_id);
