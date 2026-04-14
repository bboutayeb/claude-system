-- Migration 013: ajouter cwd et project à sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cwd TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project TEXT;

-- Backfill : pas de cwd historique → project reste NULL (affiché "—" dans le dashboard)
