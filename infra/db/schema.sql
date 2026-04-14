-- claude-monitor consolidated schema
-- Idempotent: safe to run on an existing database (upgrades and fresh installs).
--
-- RÈGLE : toute migration dans infra/db/migrations/ DOIT aussi mettre à jour ce fichier
-- pour maintenir le schéma à l'état final. Un fresh install utilise uniquement ce fichier.

-- ── sessions ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  model TEXT,
  source TEXT,
  agent_type TEXT,
  transcript_path TEXT,
  cwd TEXT,
  project TEXT
);

-- ── tool_calls ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_calls (
  id SERIAL PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  duration_ms INTEGER,
  called_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_calls_session_idx  ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS tool_calls_tool_name_idx ON tool_calls(tool_name);

-- ── ambiguities ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ambiguities (
  id SERIAL PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT,
  prompt_text TEXT NOT NULL,
  suggestion TEXT,
  source TEXT,
  false_positive BOOLEAN DEFAULT NULL,
  detected_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ambiguities_session_idx ON ambiguities(session_id);

-- ── haiku_usage ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS haiku_usage (
  id            SERIAL PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('ambiguity', 'scoring', 'realtime-scoring')),
  input_tokens  INT NOT NULL,
  output_tokens INT NOT NULL,
  cost_usd      NUMERIC(12, 8) NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── tasks ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'done', 'pending_review', 'verified', 'failed')),
  acceptance_criteria JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);

-- Auto-transition done → pending_review when acceptance_criteria is set
CREATE OR REPLACE FUNCTION auto_pending_review() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'done' AND NEW.acceptance_criteria IS NOT NULL THEN
    NEW.status = 'pending_review';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_status_guard ON tasks;
CREATE TRIGGER task_status_guard
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION auto_pending_review();

-- ── prompts ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prompts (
  id SERIAL PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_text TEXT NOT NULL,
  char_length INTEGER GENERATED ALWAYS AS (length(prompt_text)) STORED,
  is_ambiguous BOOLEAN DEFAULT false,
  quality_score NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prompts_session_idx ON prompts(session_id);
CREATE INDEX IF NOT EXISTS prompts_created_idx ON prompts(created_at);

-- ── kpi_snapshots ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kpi_snapshots (
  snapshot_date DATE PRIMARY KEY,
  total_sessions INTEGER DEFAULT 0,
  avg_input_tokens NUMERIC DEFAULT 0,
  cache_hit_rate NUMERIC DEFAULT 0,
  waste_rate NUMERIC DEFAULT 0,
  total_tokens BIGINT DEFAULT 0,
  total_output_tokens BIGINT DEFAULT 0,
  total_cache_write BIGINT DEFAULT 0,
  estimated_cost_usd NUMERIC(10,4) DEFAULT 0,
  total_tool_calls INTEGER DEFAULT 0,
  avg_tool_duration_ms INTEGER DEFAULT 0,
  tool_breakdown JSONB,
  total_prompts INTEGER DEFAULT 0,
  ambiguity_rate NUMERIC DEFAULT 0,
  avg_prompt_length INTEGER DEFAULT 0
);

-- Trigger: refresh daily KPI snapshot on session end
CREATE OR REPLACE FUNCTION upsert_kpi_snapshot() RETURNS TRIGGER AS $$
DECLARE
  v_date DATE := CURRENT_DATE;
BEGIN
  INSERT INTO kpi_snapshots (
    snapshot_date, total_sessions, avg_input_tokens, cache_hit_rate, waste_rate,
    total_tokens, total_output_tokens, total_cache_write, estimated_cost_usd,
    total_tool_calls, avg_tool_duration_ms, tool_breakdown,
    total_prompts, ambiguity_rate, avg_prompt_length
  )
  SELECT
    v_date,
    COUNT(s.id),
    ROUND(AVG(s.input_tokens)),
    ROUND(AVG(s.cache_read_tokens::numeric /
          NULLIF(s.input_tokens + s.cache_read_tokens, 0)) * 100, 2),
    ROUND(AVG(CASE WHEN s.output_tokens = 0 THEN 1 ELSE 0 END) * 100, 2),
    COALESCE(SUM(s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens), 0),
    COALESCE(SUM(s.output_tokens), 0),
    COALESCE(SUM(s.cache_write_tokens), 0),
    ROUND(COALESCE(
        SUM(s.input_tokens        *  3.0  / 1000000)
      + SUM(s.output_tokens       * 15.0  / 1000000)
      + SUM(s.cache_read_tokens   *  0.30 / 1000000)
      + SUM(s.cache_write_tokens  *  3.75 / 1000000),
    0)::numeric, 4),
    (SELECT COUNT(*) FROM tool_calls tc
       JOIN sessions s2 ON tc.session_id = s2.id
       WHERE DATE(s2.started_at) = v_date),
    (SELECT COALESCE(ROUND(AVG(tc.duration_ms)), 0) FROM tool_calls tc
       JOIN sessions s2 ON tc.session_id = s2.id
       WHERE DATE(s2.started_at) = v_date),
    (SELECT COALESCE(json_agg(t ORDER BY t.cnt DESC), '[]'::json)::jsonb
       FROM (
         SELECT tc.tool_name AS tool, COUNT(*) AS cnt, ROUND(AVG(tc.duration_ms)) AS avg_ms
         FROM tool_calls tc JOIN sessions s2 ON tc.session_id = s2.id
         WHERE DATE(s2.started_at) = v_date
         GROUP BY tc.tool_name LIMIT 20
       ) t),
    (SELECT COUNT(*) FROM prompts p WHERE DATE(p.created_at) = v_date),
    (SELECT ROUND(AVG(CASE WHEN p.is_ambiguous THEN 1.0 ELSE 0.0 END) * 100, 2)
       FROM prompts p WHERE DATE(p.created_at) = v_date),
    (SELECT COALESCE(ROUND(AVG(p.char_length)), 0)
       FROM prompts p WHERE DATE(p.created_at) = v_date)
  FROM sessions s
  WHERE DATE(s.ended_at) = v_date AND s.ended_at IS NOT NULL
  ON CONFLICT (snapshot_date) DO UPDATE SET
    total_sessions        = EXCLUDED.total_sessions,
    avg_input_tokens      = EXCLUDED.avg_input_tokens,
    cache_hit_rate        = EXCLUDED.cache_hit_rate,
    waste_rate            = EXCLUDED.waste_rate,
    total_tokens          = EXCLUDED.total_tokens,
    total_output_tokens   = EXCLUDED.total_output_tokens,
    total_cache_write     = EXCLUDED.total_cache_write,
    estimated_cost_usd    = EXCLUDED.estimated_cost_usd,
    total_tool_calls      = EXCLUDED.total_tool_calls,
    avg_tool_duration_ms  = EXCLUDED.avg_tool_duration_ms,
    tool_breakdown        = EXCLUDED.tool_breakdown,
    total_prompts         = EXCLUDED.total_prompts,
    ambiguity_rate        = EXCLUDED.ambiguity_rate,
    avg_prompt_length     = EXCLUDED.avg_prompt_length;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS refresh_kpi_on_session_stop ON sessions;
CREATE TRIGGER refresh_kpi_on_session_stop
  AFTER UPDATE OF ended_at ON sessions
  FOR EACH ROW WHEN (NEW.ended_at IS NOT NULL)
  EXECUTE FUNCTION upsert_kpi_snapshot();
