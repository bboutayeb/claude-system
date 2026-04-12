-- Trigger: upsert daily KPI snapshot whenever a session ends.
-- Fires on UPDATE of ended_at on sessions when the new value is non-null.

CREATE OR REPLACE FUNCTION upsert_kpi_snapshot() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO kpi_snapshots (snapshot_date, total_sessions, avg_input_tokens,
                             cache_hit_rate, waste_rate)
  SELECT
    CURRENT_DATE,
    COUNT(*),
    ROUND(AVG(input_tokens)),
    ROUND(AVG(cache_read_tokens::numeric /
          NULLIF(input_tokens + cache_read_tokens, 0)) * 100, 2),
    ROUND(AVG(CASE WHEN output_tokens = 0 THEN 1 ELSE 0 END) * 100, 2)
  FROM sessions
  WHERE DATE(ended_at) = CURRENT_DATE AND ended_at IS NOT NULL
  ON CONFLICT (snapshot_date) DO UPDATE SET
    total_sessions   = EXCLUDED.total_sessions,
    avg_input_tokens = EXCLUDED.avg_input_tokens,
    cache_hit_rate   = EXCLUDED.cache_hit_rate,
    waste_rate       = EXCLUDED.waste_rate;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refresh_kpi_on_session_stop
  AFTER UPDATE OF ended_at ON sessions
  FOR EACH ROW WHEN (NEW.ended_at IS NOT NULL)
  EXECUTE FUNCTION upsert_kpi_snapshot();
