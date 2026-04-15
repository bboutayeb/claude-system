import { db } from "../db"

export function parseDays(url: URL): number {
  const raw = parseInt(url.searchParams.get("days") ?? "7", 10)
  return Math.min(90, Math.max(1, isNaN(raw) ? 7 : raw))
}

export async function handleDashboardKpis(url: URL): Promise<Response> {
  const days = parseDays(url)
  const { rows } = await db.query(
    `SELECT snapshot_date, total_sessions, estimated_cost_usd,
            cache_hit_rate, ambiguity_rate, total_tokens, total_output_tokens,
            total_prompts, avg_prompt_length
     FROM kpi_snapshots
     WHERE snapshot_date >= CURRENT_DATE - $1::int
     ORDER BY snapshot_date
     LIMIT 90`,
    [days]
  )
  return new Response(JSON.stringify({ rows }), {
    headers: { "Content-Type": "application/json" },
  })
}

export async function handleDashboardTools(url: URL): Promise<Response> {
  const days = parseDays(url)
  const { rows } = await db.query(
    `SELECT tool_name, COUNT(*) AS call_count,
            ROUND(AVG(duration_ms)) AS avg_duration_ms
     FROM tool_calls
     WHERE called_at >= CURRENT_DATE - $1::int
     GROUP BY tool_name
     ORDER BY call_count DESC
     LIMIT 20`,
    [days]
  )
  return new Response(JSON.stringify({ tools: rows }), {
    headers: { "Content-Type": "application/json" },
  })
}

export async function handleDashboardPrompts(url: URL): Promise<Response> {
  const days = parseDays(url)
  const { rows } = await db.query(
    `SELECT DATE(created_at) AS day,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE is_ambiguous) AS ambiguous,
            ROUND(AVG(char_length)) AS avg_length,
            ROUND(AVG(quality_score), 2) AS avg_quality
     FROM prompts
     WHERE created_at >= CURRENT_DATE - $1::int
     GROUP BY DATE(created_at)
     ORDER BY day
     LIMIT 90`,
    [days]
  )
  return new Response(JSON.stringify({ rows }), {
    headers: { "Content-Type": "application/json" },
  })
}

export async function handleDashboardSessions(url: URL): Promise<Response> {
  const days = parseDays(url)
  const project = url.searchParams.get("project") || null
  const { rows } = await db.query(
    `SELECT s.id,
            s.started_at,
            s.ended_at,
            s.model,
            s.project,
            s.transcript_path,
            p_agg.prompt_count,
            p_agg.avg_quality,
            a_agg.ambiguity_count,
            a_agg.ambiguity_ia,
            a_agg.ambiguity_heuristique
     FROM sessions s
     LEFT JOIN LATERAL (
       SELECT COUNT(*)                        AS prompt_count,
              ROUND(AVG(quality_score), 2)    AS avg_quality
       FROM prompts WHERE session_id = s.id
     ) p_agg ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*)                                            AS ambiguity_count,
              COUNT(*) FILTER (WHERE source = 'ia')              AS ambiguity_ia,
              COUNT(*) FILTER (WHERE source = 'heuristique')     AS ambiguity_heuristique
       FROM ambiguities WHERE session_id = s.id
     ) a_agg ON true
     WHERE s.started_at >= CURRENT_DATE - $1::int
       AND ($2::text IS NULL OR s.project = $2)
     ORDER BY s.started_at DESC
     LIMIT 50`,
    [days, project]
  )
  return new Response(JSON.stringify({ sessions: rows }), {
    headers: { "Content-Type": "application/json" },
  })
}

export async function handleDashboardProjects(): Promise<Response> {
  const { rows } = await db.query(
    `SELECT DISTINCT project FROM sessions
     WHERE project IS NOT NULL
     ORDER BY project
     LIMIT 50`
  )
  return new Response(JSON.stringify({ projects: rows.map(r => r.project) }), {
    headers: { "Content-Type": "application/json" },
  })
}

export async function handleDashboardProjectStats(url: URL): Promise<Response> {
  const days = parseDays(url)
  const project = url.searchParams.get("project")
  if (!project) {
    return new Response(JSON.stringify({ error: "project required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }
  const { rows } = await db.query(
    `WITH filtered_sessions AS (
       SELECT s.id, s.input_tokens, s.output_tokens
       FROM sessions s
       WHERE s.project = $1
         AND s.started_at >= CURRENT_DATE - $2::int
     ),
     session_stats AS (
       SELECT
         COUNT(*)                        AS total_sessions,
         COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens
       FROM filtered_sessions
     ),
     prompt_stats AS (
       SELECT
         ROUND(AVG(p.quality_score), 2)  AS avg_quality,
         COUNT(p.id)                     AS total_prompts
       FROM filtered_sessions fs
       LEFT JOIN prompts p ON p.session_id = fs.id
     ),
     ambiguity_stats AS (
       SELECT COUNT(a.id) AS total_ambiguities
       FROM filtered_sessions fs
       LEFT JOIN ambiguities a ON a.session_id = fs.id
     )
     SELECT
       ss.total_sessions,
       ss.total_input_tokens,
       ss.total_output_tokens,
       ps.avg_quality,
       ps.total_prompts,
       aps.total_ambiguities
     FROM session_stats ss
     CROSS JOIN prompt_stats ps
     CROSS JOIN ambiguity_stats aps`,
    [project, days]
  )
  return new Response(JSON.stringify({ stats: rows[0] ?? null }), {
    headers: { "Content-Type": "application/json" },
  })
}

export async function handleDashboardHaikuCost(url: URL): Promise<Response> {
  const days = parseDays(url)
  const { rows } = await db.query(
    `SELECT
       DATE(created_at)                          AS day,
       SUM(input_tokens)                         AS input_tokens,
       SUM(output_tokens)                        AS output_tokens,
       ROUND(SUM(cost_usd)::numeric, 6)          AS cost_usd,
       SUM(cost_usd) FILTER (WHERE source = 'ambiguity')  AS cost_ambiguity,
       SUM(cost_usd) FILTER (WHERE source = 'scoring')    AS cost_scoring,
       COUNT(*)                                  AS call_count
     FROM haiku_usage
     WHERE created_at >= CURRENT_DATE - $1::int
     GROUP BY DATE(created_at)
     ORDER BY day
     LIMIT 90`,
    [days]
  )
  const { rows: totals } = await db.query(
    `SELECT
       ROUND(SUM(cost_usd)::numeric, 6)  AS total_cost_usd,
       COUNT(*)                          AS total_calls
     FROM haiku_usage
     WHERE created_at >= CURRENT_DATE - $1::int`,
    [days]
  )
  return new Response(
    JSON.stringify({ rows, total_cost_usd: totals[0]?.total_cost_usd ?? 0, total_calls: totals[0]?.total_calls ?? 0 }),
    { headers: { "Content-Type": "application/json" } }
  )
}

export async function handleTranscript(url: URL): Promise<Response> {
  const path = url.searchParams.get("path")
  if (!path) {
    return new Response("Missing path", { status: 400 })
  }

  // Security: only serve files whose path is registered in sessions.transcript_path
  const { rows } = await db.query(
    "SELECT 1 FROM sessions WHERE transcript_path = $1 LIMIT 1",
    [path]
  )
  if (rows.length === 0) {
    return new Response("Not found", { status: 404 })
  }

  try {
    const content = await Bun.file(path).text()
    return new Response(content, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  } catch {
    return new Response("File not found", { status: 404 })
  }
}
