-- Replace webhook_events.repo (text copy) with webhook_events.repo_id (FK to repos).
-- Repo names can change; the repos table provides stable identity.

-- 1. Add repo_id as a nullable FK (historical rows have no matching repo record).
ALTER TABLE webhook_events ADD COLUMN repo_id bigint REFERENCES repos(id);

-- 2. Backfill repo_id for rows whose repo text matches an existing repos record.
UPDATE webhook_events w
SET repo_id = r.id
FROM repos r
WHERE r.full_name = w.repo;

-- 3. Drop the old text column.
ALTER TABLE webhook_events DROP COLUMN repo;
