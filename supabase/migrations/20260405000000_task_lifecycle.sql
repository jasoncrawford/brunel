-- New task lifecycle with derived status
-- Track issue closure and PR merge separately; status becomes derived

ALTER TABLE tasks ADD COLUMN issue_closed_at timestamptz;
ALTER TABLE tasks ADD COLUMN pr_merged_at timestamptz;
DROP INDEX tasks_status_idx;
ALTER TABLE tasks DROP COLUMN status;
