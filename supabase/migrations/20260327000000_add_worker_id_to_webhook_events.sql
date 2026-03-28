ALTER TABLE webhook_events ADD COLUMN worker_id text;

CREATE INDEX ON webhook_events (worker_id);
