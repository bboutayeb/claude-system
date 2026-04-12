-- Étape 3 : KPIs enrichis + nettoyage colonne morte

-- 1. Supprimer input_tokens (colonne morte — PostToolUse n'envoie pas usage)
ALTER TABLE tool_calls DROP COLUMN input_tokens;

-- 2. Nouvelles colonnes kpi_snapshots
ALTER TABLE kpi_snapshots ADD COLUMN total_tokens        BIGINT  DEFAULT 0;
ALTER TABLE kpi_snapshots ADD COLUMN total_output_tokens BIGINT  DEFAULT 0;
ALTER TABLE kpi_snapshots ADD COLUMN total_cache_write   BIGINT  DEFAULT 0;
ALTER TABLE kpi_snapshots ADD COLUMN estimated_cost_usd  NUMERIC(10,4) DEFAULT 0;
ALTER TABLE kpi_snapshots ADD COLUMN total_tool_calls    INTEGER DEFAULT 0;
ALTER TABLE kpi_snapshots ADD COLUMN avg_tool_duration_ms INTEGER DEFAULT 0;
ALTER TABLE kpi_snapshots ADD COLUMN tool_breakdown      JSONB;
ALTER TABLE kpi_snapshots ADD COLUMN total_prompts       INTEGER DEFAULT 0;
ALTER TABLE kpi_snapshots ADD COLUMN ambiguity_rate      NUMERIC DEFAULT 0;
ALTER TABLE kpi_snapshots ADD COLUMN avg_prompt_length   INTEGER DEFAULT 0;

-- 3. Réécriture de la fonction trigger avec les 10 métriques
CREATE OR REPLACE FUNCTION upsert_kpi_snapshot() RETURNS TRIGGER AS $$
DECLARE
  v_date DATE := CURRENT_DATE;
BEGIN
  INSERT INTO kpi_snapshots (
    snapshot_date,
    total_sessions,
    avg_input_tokens,
    cache_hit_rate,
    waste_rate,
    total_tokens,
    total_output_tokens,
    total_cache_write,
    estimated_cost_usd,
    total_tool_calls,
    avg_tool_duration_ms,
    tool_breakdown,
    total_prompts,
    ambiguity_rate,
    avg_prompt_length
  )
  SELECT
    v_date,
    -- sessions métriques existantes
    COUNT(s.id),
    ROUND(AVG(s.input_tokens)),
    ROUND(AVG(s.cache_read_tokens::numeric /
          NULLIF(s.input_tokens + s.cache_read_tokens, 0)) * 100, 2),
    ROUND(AVG(CASE WHEN s.output_tokens = 0 THEN 1 ELSE 0 END) * 100, 2),
    -- volume total de tokens
    COALESCE(SUM(s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens), 0),
    COALESCE(SUM(s.output_tokens), 0),
    COALESCE(SUM(s.cache_write_tokens), 0),
    -- coût estimé USD (pricing Sonnet 4 2026)
    ROUND(COALESCE(
      SUM(s.input_tokens        *  3.0  / 1000000)
    + SUM(s.output_tokens       * 15.0  / 1000000)
    + SUM(s.cache_read_tokens   *  0.30 / 1000000)
    + SUM(s.cache_write_tokens  *  3.75 / 1000000),
    0)::numeric, 4),
    -- tool_calls
    (SELECT COUNT(*) FROM tool_calls tc
       JOIN sessions s2 ON tc.session_id = s2.id
       WHERE DATE(s2.started_at) = v_date),
    (SELECT COALESCE(ROUND(AVG(tc.duration_ms)), 0) FROM tool_calls tc
       JOIN sessions s2 ON tc.session_id = s2.id
       WHERE DATE(s2.started_at) = v_date),
    (SELECT COALESCE(json_agg(t ORDER BY t.cnt DESC), '[]'::json)::jsonb
       FROM (
         SELECT tc.tool_name AS tool, COUNT(*) AS cnt,
                ROUND(AVG(tc.duration_ms)) AS avg_ms
         FROM tool_calls tc
           JOIN sessions s2 ON tc.session_id = s2.id
         WHERE DATE(s2.started_at) = v_date
         GROUP BY tc.tool_name
         LIMIT 20
       ) t),
    -- prompts
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
