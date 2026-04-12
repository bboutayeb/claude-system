-- Étape 1 : capturer model, source, agent_type reçus dans SessionStart
ALTER TABLE sessions ADD COLUMN model TEXT;
ALTER TABLE sessions ADD COLUMN source TEXT;       -- startup | resume | clear | compact
ALTER TABLE sessions ADD COLUMN agent_type TEXT;   -- null = interactif, 'verifier' = cron, etc.
