-- Migration 013: ajouter cwd et project à sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cwd TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project TEXT;

-- Backfill : pas de cwd historique → project reste NULL (affiché "—" dans le dashboard)

CREATE INDEX IF NOT EXISTS idx_sessions_project_started_at
  ON sessions (project, started_at DESC)
  WHERE project IS NOT NULL;
