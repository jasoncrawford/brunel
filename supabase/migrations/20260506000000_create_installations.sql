CREATE TABLE installations (
  id            bigserial PRIMARY KEY,
  github_id     bigint NOT NULL UNIQUE,  -- GitHub's installation_id
  account_login text NOT NULL,           -- org or user login
  account_type  text NOT NULL CHECK (account_type IN ('User', 'Organization')),
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE repos ADD COLUMN installation_id bigint REFERENCES installations(id);
