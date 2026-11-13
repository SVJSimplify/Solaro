-- Keeps per-message metadata (booking forms, handoff reason, urgency) so it survives a reload in live mode.
alter table messages add column if not exists meta jsonb;
