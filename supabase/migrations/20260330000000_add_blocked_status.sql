-- Add blocked as a valid task status.
-- Postgres does not enforce text-column enums, so no constraint change is needed.
-- (The status column is plain text; application code is the constraint.)

-- Track individual blocker relationships.
CREATE TABLE task_blockers (
  task_id              text    NOT NULL,
  blocker_issue_number integer NOT NULL,
  closed_at            timestamptz,
  PRIMARY KEY (task_id, blocker_issue_number),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);

CREATE INDEX task_blockers_task_id_idx ON task_blockers (task_id);
