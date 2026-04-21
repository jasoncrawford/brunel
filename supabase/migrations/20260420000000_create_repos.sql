-- Stable identity for a GitHub repository, independent of repo name.
-- status: 'new' = known but not yet activated, 'active' = in play.

CREATE TABLE repos (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name  text        NOT NULL UNIQUE,
  status     text        NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now()
);
