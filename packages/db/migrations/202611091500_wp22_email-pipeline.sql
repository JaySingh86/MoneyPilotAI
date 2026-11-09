-- WP-22 · Email processing pipeline (BACKEND_PLAN §7.8.2, §7.9, §9; ARCHITECTURE §4.3). Expand-only.
--
-- What the pipeline needs that WP-14 and WP-21 did not create:
--   households.auto_apply_enabled
--                   the `auto_apply` feature flag, per household, OFF by default. The worker reads it before an email may
--                   change an item by itself. No app role can write it (no grant): G3 gates turning it on, and the owner
--                   does that by hand (Q-231 records why this is a column and not the `feature_flags` table).
--   ai_runs         metering and debugging for model calls: tokens, cost estimate, stop reason, status. Never a prompt
--                   or an output (BACKEND_PLAN §5, §7.9). Written by the worker; members can read their own household's.
--   email_messages  `intake` says whether discovery found the message live or the first 13-month backfill did (backfill
--                   goes through the Batch API, new mail is a direct call); `ai_batch_id` is the Batch API batch a
--                   message is waiting in. The body is never stored: a collected batch re-reads the message.
--   extracted_items the foreign key to email_messages that WP-14 left to the table's owner (Q-192), and a unique
--                   index so one message yields at most one review row, whatever a retry does.

-- ===== households.auto_apply_enabled =====
alter table households add column auto_apply_enabled boolean not null default false;

-- ===== ai_runs =====
create table ai_runs (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references households(id) on delete cascade,
  purpose            text not null check (purpose in ('extract','explain','ask','eval')),
  model_id           text not null check (char_length(model_id) <= 100),
  prompt_version     text not null check (char_length(prompt_version) <= 60),
  batch              boolean not null default false,
  input_tokens       int check (input_tokens >= 0),
  output_tokens      int check (output_tokens >= 0),
  cache_read_tokens  int check (cache_read_tokens >= 0),
  cache_write_tokens int check (cache_write_tokens >= 0),
  cost_micros        bigint check (cost_micros >= 0),       -- an estimate in micro-dollars (Q-071), never an invoice figure
  cost_estimated     boolean not null default false,
  stop_reason        text check (char_length(stop_reason) <= 60),
  latency_ms         int check (latency_ms >= 0),
  status             text not null check (status in ('ok','refusal','invalid_output','error')),
  created_at         timestamptz not null default now()
);
create index ai_runs_household_idx on ai_runs(household_id, created_at desc);

-- ===== email_messages =====
alter table email_messages
  add column intake      text not null default 'discover' check (intake in ('discover','backfill')),
  add column ai_batch_id text check (ai_batch_id is null or char_length(ai_batch_id) <= 100);
create index email_messages_pending_idx on email_messages(connection_id, intake, received_at)
  where stage = 'discovered';
create index email_messages_batch_idx on email_messages(ai_batch_id) where ai_batch_id is not null and stage = 'discovered';

-- ===== extracted_items =====
-- A message removed by the 13-month purge leaves its review rows (set null), as for every other reference.
alter table extracted_items add constraint extracted_items_message_fk
  foreign key (message_id, household_id) references email_messages(id, household_id)
  on delete set null (message_id);
create unique index extracted_items_message_uq on extracted_items(message_id) where message_id is not null;

-- ===== Row-level security =====
alter table ai_runs enable row level security;
alter table ai_runs force row level security;

-- Model usage is written by the worker for its own household, and members can read their household's (the daily Ask
-- cap counts today's rows, BACKEND_PLAN §8).
create policy ai_runs_worker_job_scope on ai_runs for all to mp_worker
  using (household_id = app_household_id()) with check (household_id = app_household_id());
create policy ai_runs_api_select on ai_runs for select to mp_api
  using (app_is_household_member(household_id));

-- ===== Grants =====
grant select on ai_runs to mp_api;
grant select, insert on ai_runs to mp_worker;

-- Messages: the worker sets `intake` when discovery writes the row and the batch id when a batch is submitted.
grant insert (intake) on email_messages to mp_worker;
grant update (ai_batch_id) on email_messages to mp_worker;
