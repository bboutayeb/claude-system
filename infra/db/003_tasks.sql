CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'done', 'pending_review', 'verified', 'failed')),
  acceptance_criteria JSONB,
  -- Examples:
  --   {"type": "sql_count", "query": "SELECT COUNT(*) FROM sessions", "min": 1}
  --   {"type": "file_exists", "path": "dist/index.js"}
  --   {"type": "pattern", "file": "hooks-server/server.ts", "regex": "Bun.serve"}
  --   {"type": "no_error", "command": "bun run hooks-server/server.ts --dry-run"}
  --   {"type": "heuristic", "file": "CLAUDE.md", "min_chars": 500}
  created_at TIMESTAMPTZ DEFAULT now(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX tasks_status_idx ON tasks(status);

-- Transition automatique : done → pending_review quand acceptance_criteria est présent
CREATE OR REPLACE FUNCTION auto_pending_review() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'done' AND NEW.acceptance_criteria IS NOT NULL THEN
    NEW.status = 'pending_review';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER task_status_guard
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION auto_pending_review();
