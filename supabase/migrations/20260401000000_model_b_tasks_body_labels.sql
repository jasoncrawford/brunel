-- Add body and labels columns to tasks table (Model B: DB is authoritative)
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS body   text     NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS labels text[]   NOT NULL DEFAULT '{}';

-- Add unique constraint on issue_number (task_id = String(issue_number) already
-- enforces this, but make it explicit so the schema reflects the intent)
ALTER TABLE tasks
  ADD CONSTRAINT tasks_issue_number_unique UNIQUE (issue_number);

-- Drop the task_assignments table — it is dead code since PR #406 migrated
-- restart recovery to the tasks table. TaskAssignmentStore was never called
-- from foreman.ts.
DROP TABLE IF EXISTS task_assignments;
