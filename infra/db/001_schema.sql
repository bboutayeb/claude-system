-- Sessions: one row per Claude Code session
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0
);

-- Tool calls: one row per PreToolUse/PostToolUse event
CREATE TABLE tool_calls (
  id SERIAL PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  duration_ms INTEGER,
  input_tokens INTEGER DEFAULT 0,
  called_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX tool_calls_session_idx ON tool_calls(session_id);
CREATE INDEX tool_calls_tool_name_idx ON tool_calls(tool_name);

-- Daily KPI snapshots (populated by a cron or end-of-session trigger)
CREATE TABLE kpi_snapshots (
  snapshot_date DATE PRIMARY KEY,
  total_sessions INTEGER DEFAULT 0,
  avg_input_tokens NUMERIC DEFAULT 0,
  cache_hit_rate NUMERIC DEFAULT 0,
  waste_rate NUMERIC DEFAULT 0
);
