ALTER TABLE webhook_events ADD COLUMN worker_id text REFERENCES workers(id);

CREATE INDEX ON webhook_events (worker_id);
