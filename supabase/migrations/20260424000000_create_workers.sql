CREATE TABLE workers (
  worker_id text PRIMARY KEY,
  repo_id integer NOT NULL REFERENCES repos(id),
  repo_full_name text NOT NULL,
  status text NOT NULL DEFAULT 'idle',
  current_task_id text,
  first_connected_at timestamptz NOT NULL DEFAULT now(),
  last_connected_at timestamptz NOT NULL DEFAULT now(),
  num_connections integer NOT NULL DEFAULT 1,
  disconnected_at timestamptz,
  goodbye_at timestamptz
);
