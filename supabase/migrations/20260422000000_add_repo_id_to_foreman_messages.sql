-- Add repo_id FK to foreman_messages so task-free messages (worker_hello,
-- hello_ack, etc.) can still be scoped to a repo on the dashboard.

ALTER TABLE foreman_messages
  ADD COLUMN repo_id bigint REFERENCES repos(id);

CREATE INDEX ON foreman_messages (repo_id);
