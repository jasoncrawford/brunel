-- Drop the task_blockers table. Blocker relationships are derived state
-- (re-computed from GitHub issue bodies on startup) and do not need to be
-- persisted. The tasks.status = 'blocked' column captures whether a task
-- is blocked; the specific blocker issues are re-fetched from GitHub.
DROP TABLE IF EXISTS task_blockers;
