-- Migrate worker status column to use the new protocol vocabulary.
-- idle → ready, busy → assigned (reserved/disconnected are already correct).
UPDATE workers SET status = 'ready' WHERE status = 'idle';
UPDATE workers SET status = 'assigned' WHERE status = 'busy';
ALTER TABLE workers ALTER COLUMN status SET DEFAULT 'ready';
