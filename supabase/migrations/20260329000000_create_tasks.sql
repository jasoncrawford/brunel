-- Persist all tasks (including completed) for the /tasks dashboard page.
-- The task_assignments table remains for restart-recovery of in-flight tasks;
-- this table stores the full lifecycle history of every task.

CREATE TABLE tasks (
  task_id      text        PRIMARY KEY,
  issue_number integer     NOT NULL,
  repo         text        NOT NULL,
  title        text        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending',
  worker_id    text,
  pr_number    integer,
  branch       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  assigned_at  timestamptz,
  completed_at timestamptz
);

CREATE INDEX tasks_status_idx      ON tasks (status);
CREATE INDEX tasks_created_at_idx  ON tasks (created_at DESC);
