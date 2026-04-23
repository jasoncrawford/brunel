ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS input_tokens  integer,
  ADD COLUMN IF NOT EXISTS output_tokens integer,
  ADD COLUMN IF NOT EXISTS cost_usd      numeric(12, 6);
