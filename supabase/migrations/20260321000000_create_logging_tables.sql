create table webhook_events (
  id            bigint generated always as identity primary key,
  received_at   timestamptz not null default now(),
  delivery_id   text,
  event_name    text not null,
  action        text,
  repo          text,
  sender        text,
  issue_number  int,
  pr_number     int,
  branch        text,
  task_id       text,
  payload       jsonb not null
);

create index on webhook_events (task_id);
create index on webhook_events (received_at desc);

create table foreman_messages (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  direction   text not null,
  worker_id   text,
  task_id     text,
  msg_type    text not null,
  payload     jsonb not null
);

create index on foreman_messages (task_id);
create index on foreman_messages (worker_id);
create index on foreman_messages (created_at desc);
