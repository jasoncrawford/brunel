create table task_assignments (
  task_id       text primary key,
  worker_id     text not null,
  pr_number     integer,
  branch        text,
  assigned_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
