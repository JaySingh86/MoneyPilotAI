-- WP-12 · calc_snapshots (BACKEND_PLAN §5.2, §7.2). Expand-only: one new table.
--
-- A snapshot is the engine result for one input, so "See the math", explanations and proposals can point at
-- exactly what the user saw. Rows are deduplicated by (household, inputs_hash, engine_version): the same
-- input read twice gives the same row and the same id. They are immutable (no UPDATE or DELETE grant for
-- either app role); a retention job (WP-24) removes old ones through its own definer function.
--
-- `result` holds amounts, as the other household tables do; it is never logged (hard rule 8).
--
-- RLS (same model as WP-06): mp_api sees and writes a household through an active membership of
-- app_user_id(); mp_worker only the job's household (app_household_id()). Enabled AND forced.

create table calc_snapshots (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households(id) on delete cascade,
  engine_version text not null check (char_length(engine_version) between 1 and 40),
  as_of          date not null,
  inputs_hash    bytea not null check (octet_length(inputs_hash) = 32),  -- sha256 of the canonical engine input
  result         jsonb not null,
  created_at     timestamptz not null default now(),
  unique (household_id, inputs_hash, engine_version),
  unique (id, household_id)   -- lets ai_texts and proposals reference a snapshot of the same household only
);

alter table calc_snapshots enable row level security;
alter table calc_snapshots force row level security;

create policy calc_snapshots_api_select on calc_snapshots for select to mp_api
  using (app_is_household_member(household_id));
create policy calc_snapshots_api_insert on calc_snapshots for insert to mp_api
  with check (app_is_household_member(household_id));
create policy calc_snapshots_worker_select on calc_snapshots for select to mp_worker
  using (household_id = app_household_id());
create policy calc_snapshots_worker_insert on calc_snapshots for insert to mp_worker
  with check (household_id = app_household_id());

grant select on calc_snapshots to mp_api, mp_worker;
grant insert (id, household_id, engine_version, as_of, inputs_hash, result) on calc_snapshots
  to mp_api, mp_worker;
