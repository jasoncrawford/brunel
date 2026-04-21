-- Fix UNIQUE(issue_number) → UNIQUE(issue_number, repo_id)
-- Issue numbers are repo-scoped; two different repos can both have issue #42.

-- 1. Add repo_id as a nullable FK so existing rows don't immediately fail.
ALTER TABLE tasks ADD COLUMN repo_id bigint REFERENCES repos(id);

-- 2. Ensure all repos referenced by tasks exist in the repos table.
INSERT INTO repos (full_name)
SELECT DISTINCT repo FROM tasks
WHERE repo IS NOT NULL AND repo != ''
  AND repo NOT IN (SELECT full_name FROM repos)
ON CONFLICT (full_name) DO NOTHING;

-- 3. Populate repo_id from the existing repo text column.
UPDATE tasks t
SET repo_id = r.id
FROM repos r
WHERE r.full_name = t.repo;

-- 4. Make repo_id NOT NULL now that all rows are populated.
ALTER TABLE tasks ALTER COLUMN repo_id SET NOT NULL;

-- 5. Drop the old single-column unique constraint.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_issue_number_unique;

-- 6. Add the new composite unique constraint.
ALTER TABLE tasks ADD CONSTRAINT tasks_issue_number_repo_id_unique UNIQUE (issue_number, repo_id);
