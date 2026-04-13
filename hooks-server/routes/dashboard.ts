import { db } from "../db"

export async function handleDashboardKpis(url: URL): Promise<Response> {
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") ?? "7")))
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
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") ?? "7")))
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
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") ?? "7")))
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
