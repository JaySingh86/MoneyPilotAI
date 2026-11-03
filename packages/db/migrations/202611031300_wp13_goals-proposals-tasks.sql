-- WP-13 · Goal events, proposals, tasks, and the goals write grants (BACKEND_PLAN §5.2, §7.3, §7.4;
-- ARCHITECTURE §4.5). Expand-only.
--
-- RLS model as in WP-06: mp_api sees a household through an active membership (app_is_household_member),
-- mp_worker sees exactly app_household_id(). Every table has RLS enabled AND forced and a policy for both
-- roles. Child rows reference their parent with a composite (id, household_id) foreign key so a row can
-- never point at another household's goal, item or member.

-- ===== goals: the API may write (WP-06 left mp_api SELECT-only, Q-050) =====
-- The proposal gate for monthly amounts is in the service (a change to monthly_cents by a request needs the
-- other member's approval, §7.3); the approval itself is applied by the same role. Deposits never write
-- saved_cents directly: the service inserts a goal_events row and updates saved_cents in one transaction.
create policy goals_api_insert on goals for insert to mp_api
  with check (app_is_household_member(household_id) and created_by = app_user_id());
create policy goals_api_update on goals for update to mp_api
  using (app_is_household_member(household_id)) with check (app_is_household_member(household_id));
grant insert (id, household_id, name, type, target_cents, saved_cents, monthly_cents, target_date, color_slot,
              is_emergency_fund, status, created_by) on goals to mp_api;
grant update (name, target_cents, saved_cents, monthly_cents, target_date, color_slot, status, deleted_at)
  on goals to mp_api;

-- ===== goal_events: user-recorded deposits and withdrawals (we never move money) =====
create table goal_events (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  goal_id      uuid not null,
  kind         text not null check (kind in ('deposit','withdrawal','adjustment')),
  amount_cents bigint not null check (amount_cents <> 0 and abs(amount_cents) <= 100000000000),
  occurred_on  date not null,
  note         text check (char_length(note) <= 200),
  recorded_by  uuid references users(id),
  created_at   timestamptz not null default now(),
  -- a deposit or withdrawal is a positive amount (the kind says the direction); an adjustment is signed
  check (kind = 'adjustment' or amount_cents > 0),
  foreign key (goal_id, household_id) references goals(id, household_id) on delete cascade
);
create index goal_events_goal_idx on goal_events(goal_id, occurred_on desc, created_at desc);

-- ===== proposals: "Ask Jordan to approve" =====
create table proposals (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references households(id) on delete cascade,
  kind             text not null check (kind in ('goal_change','item_change','shortfall_option','plan_option')),
  payload          jsonb not null,                     -- validated diff (contracts.ProposalPayload)
  calc_snapshot_id uuid,                               -- the math shown when proposed
  proposed_by      uuid not null references users(id),
  status           text not null default 'pending'
                     check (status in ('pending','approved','rejected','expired','applied','superseded')),
  decided_by       uuid references users(id),
  decided_at       timestamptz,
  decision_note    text check (char_length(decision_note) <= 200),  -- why it was superseded or expired
  expires_at       timestamptz not null,               -- 7 days after creation
  created_at       timestamptz not null default now(),
  -- the proposer can never decide their own proposal
  check (decided_by is null or decided_by <> proposed_by),
  foreign key (household_id, proposed_by) references household_members(household_id, user_id),
  unique (id, household_id)
);
create index proposals_pending_idx on proposals(household_id, expires_at) where status = 'pending';
create index proposals_household_idx on proposals(household_id, created_at desc);

-- ===== tasks =====
create table tasks (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references households(id) on delete cascade,
  title              text not null check (char_length(title) between 1 and 140),
  owner_type         owner_type not null,
  owner_user_id      uuid,
  due_on             date,
  due_hint           text check (char_length(due_hint) <= 140),   -- "When the bill arrives, about Nov 1"
  linked_item_id     uuid,
  source             text not null check (source in ('user','engine','email','renewal','setup')),
  dedupe_key         text check (char_length(dedupe_key) <= 200), -- engine tasks: one per flag key
  auto_complete_rule jsonb,                            -- e.g. {"type":"actual_amount_received","itemId":"..."}
  completed_at       timestamptz,
  completed_by       uuid references users(id),        -- null when auto-completed
  completed_reason   text check (char_length(completed_reason) <= 60),
  version            int not null default 1,           -- If-Match concurrency (BACKEND_PLAN §5.1)
  created_by         uuid references users(id),
  created_at         timestamptz not null default now(),
  check ((owner_type = 'member') = (owner_user_id is not null)),
  check ((completed_at is null) = (completed_reason is null)),
  foreign key (household_id, owner_user_id) references household_members(household_id, user_id),
  foreign key (linked_item_id, household_id) references recurring_items(id, household_id)
);
create index tasks_open_idx on tasks(household_id, due_on) where completed_at is null;
create unique index tasks_dedupe_uq on tasks(household_id, dedupe_key) where dedupe_key is not null;
create trigger tasks_bump_version before update on tasks
  for each row execute function app_bump_version();

-- ===== Row-level security =====
do $$
declare
  t text;
begin
  foreach t in array array['goal_events','proposals','tasks']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I on %I for select to mp_api using (app_is_household_member(household_id))$p$,
      t || '_api_select', t);
    execute format($p$create policy %I on %I for all to mp_worker
      using (household_id = app_household_id()) with check (household_id = app_household_id())$p$,
      t || '_worker_job_scope', t);
  end loop;
end
$$;

-- Rows the API creates are attributed to the caller.
create policy goal_events_api_insert on goal_events for insert to mp_api
  with check (app_is_household_member(household_id) and recorded_by = app_user_id());
create policy proposals_api_insert on proposals for insert to mp_api
  with check (app_is_household_member(household_id) and proposed_by = app_user_id() and status = 'pending');
-- A decision: only a pending proposal, and only recorded as the deciding member, who is never the proposer
-- (the CHECK on decided_by <> proposed_by is the second lock).
create policy proposals_api_update on proposals for update to mp_api
  using (app_is_household_member(household_id) and status = 'pending')
  with check (app_is_household_member(household_id)
              and (decided_by is null or (decided_by = app_user_id() and proposed_by <> app_user_id())));
create policy tasks_api_insert on tasks for insert to mp_api
  with check (app_is_household_member(household_id) and created_by = app_user_id() and completed_at is null);
create policy tasks_api_update on tasks for update to mp_api
  using (app_is_household_member(household_id)) with check (app_is_household_member(household_id));

-- ===== Grants (per command, per column for writes) =====
grant select on goal_events, proposals, tasks to mp_api, mp_worker;

-- goal_events are append-only.
grant insert (id, household_id, goal_id, kind, amount_cents, occurred_on, note, recorded_by)
  on goal_events to mp_api, mp_worker;

-- proposals: the API creates and decides; the worker expires pending ones (proposals.expire).
grant insert (id, household_id, kind, payload, calc_snapshot_id, proposed_by, expires_at)
  on proposals to mp_api;
grant update (status, decided_by, decided_at, decision_note) on proposals to mp_api;
grant update (status, decision_note) on proposals to mp_worker;

-- tasks: no hard delete. Engine, email, renewal and setup tasks are created by workers.
grant insert (id, household_id, title, owner_type, owner_user_id, due_on, due_hint, linked_item_id, source,
              dedupe_key, auto_complete_rule, completed_at, completed_by, completed_reason, created_by)
  on tasks to mp_api, mp_worker;
grant update (title, owner_type, owner_user_id, due_on, due_hint, completed_at, completed_by, completed_reason)
  on tasks to mp_api, mp_worker;
