-- WP-06 · Items, schedules, renewals, occurrences, planned expenses, balances and goals
-- (BACKEND_PLAN §5.1, §5.2, §5.3, §7.1, §7.5; ADR-003, ADR-006). Expand-only.
--
-- RLS model (same as WP-03): mp_api sees a household through an active membership of app_user_id()
-- (app_is_household_member); mp_worker sees exactly app_household_id(). Every table has RLS enabled AND
-- forced, a policy for both app roles, and grants per command (per column for writes).
--
-- Tenant integrity beyond RLS: child tables reference their item/goal with a composite
-- (id, household_id) foreign key, so a row can never point at another household's item even if the
-- caller guesses its id (an FK check is not subject to RLS).

-- ===== Types =====
create type item_direction as enum ('outflow','inflow');
create type item_kind as enum ('bill','subscription','insurance','membership','registration','loan','income','other');
create type owner_type as enum ('member','both','split');

-- ===== goals =====
-- Created here (not in WP-13) because planned_expenses.goal_id references it and the engine input needs
-- goals.is_emergency_fund (Q-020, WP-06 acceptance). WP-13 owns the goals API, proposals and goal_events.
create table goals (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 80),
  type          text not null check (type in ('savings','planned_expense')),
  target_cents  bigint not null check (target_cents > 0),
  saved_cents   bigint not null default 0 check (saved_cents >= 0),
  monthly_cents bigint not null default 0 check (monthly_cents >= 0),
  target_date   date,
  color_slot    smallint not null default 1 check (color_slot between 1 and 3),
  is_emergency_fund boolean not null default false,  -- the goal shortfall option 1 draws from (DESIGN_SPEC §5.3)
  status        text not null default 'active' check (status in ('active','reached','archived')),
  version       int not null default 1,              -- If-Match concurrency (BACKEND_PLAN §5.1)
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (id, household_id)
);
create unique index goals_one_emergency_fund on goals(household_id) where is_emergency_fund and deleted_at is null;
create index goals_household_idx on goals(household_id) where deleted_at is null;
create trigger goals_bump_version before update on goals
  for each row execute function app_bump_version();
create trigger goals_touch_updated_at before update on goals
  for each row execute function app_touch_updated_at();

-- ===== recurring_items =====
create table recurring_items (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references households(id) on delete cascade,
  direction        item_direction not null,
  kind             item_kind not null,
  category         text not null check (category in
                     ('housing','utilities','childcare','transport','debt','subscription','insurance',
                      'membership','vehicle_home','income','other')),
  name             text not null check (char_length(name) between 1 and 80),
  provider_name    text,
  provider_domain  text,                 -- used to match emails, e.g. "northgate-insurance.example"
  amount_type      text not null check (amount_type in ('fixed','estimated','statement')),
  amount_cents     bigint check (amount_cents >= 0),
  rrule            text not null,        -- RFC 5545 without DTSTART/UNTIL, e.g. 'FREQ=MONTHLY;BYMONTHDAY=-1'
  dtstart          date not null,
  until            date,
  weekend_rule     text not null default 'none' check (weekend_rule in ('none','prev_business_day','next_business_day')),
  owner_type       owner_type not null,
  owner_user_id    uuid references users(id),
  status           text not null default 'active' check (status in ('active','paused','ended','pending_review')),
  source           text not null check (source in ('manual','csv','email','bank')),
  account_last4    text check (account_last4 ~ '^[0-9A-Za-z]{2,4}$'),
  paid_from        text not null default 'account' check (paid_from in ('account','payroll')),  -- payroll = excluded from runway
  marked_possibly_unused boolean not null default false,
  subcategory      text,                 -- groups items for the possible-duplicate flag, e.g. 'music' (DESIGN_SPEC §6 rule 8)
  movable          boolean,              -- user override for shortfall option 3; null = default by kind (DESIGN_SPEC §6 rule 18)
  on_bills_page    boolean not null default true,  -- false for items that exist only as renewals (DESIGN_SPEC §6 rule 17, Q-020)
  notes            text,
  version          int not null default 1,          -- If-Match concurrency (§8.1)
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  check ((owner_type = 'member') = (owner_user_id is not null)),
  check (amount_type <> 'fixed' or amount_cents is not null),
  check (until is null or until >= dtstart),
  unique (id, household_id),
  -- The owner must belong (or have belonged) to this household; a null owner (both/split) is not checked.
  foreign key (household_id, owner_user_id) references household_members(household_id, user_id)
);
create index recurring_items_household_idx on recurring_items(household_id) where deleted_at is null;
create index recurring_items_domain_idx on recurring_items(household_id, provider_domain) where deleted_at is null;
create trigger recurring_items_bump_version before update on recurring_items
  for each row execute function app_bump_version();
create trigger recurring_items_touch_updated_at before update on recurring_items
  for each row execute function app_touch_updated_at();

-- Composite, so a household can only name one of its own items as its primary income.
alter table households add constraint households_primary_income_fk
  foreign key (primary_income_item_id, id) references recurring_items(id, household_id)
  deferrable initially deferred;

-- ===== renewal_details (1:1 with recurring_items) =====
create table renewal_details (
  item_id               uuid primary key,
  household_id          uuid not null references households(id) on delete cascade,
  auto_renews           text not null default 'yes' check (auto_renews in ('yes','no','rolls_over')),
  coverage_start        date,
  coverage_end          date,                         -- the renewal date (Q-052)
  cancel_by             date,
  decision_by           date,
  shop_around_on        date,                         -- renewal − 30 days (DESIGN_SPEC §6 rule 11)
  previous_amount_cents bigint check (previous_amount_cents >= 0),
  price_changed_on      date,
  document_s3_key       text,                         -- e.g. policy declarations PDF from email
  foreign key (item_id, household_id) references recurring_items(id, household_id) on delete cascade
);
create index renewal_details_household_idx on renewal_details(household_id);
comment on column renewal_details.coverage_end is
  'The renewal date (Q-052). For an item paid monthly from payroll it is the plan-year renewal, not the next payment.';

-- ===== item_amount_history =====
create table item_amount_history (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  item_id      uuid not null,
  occurred_on  date not null,
  amount_cents bigint not null check (amount_cents >= 0),
  source       text not null check (source in ('manual','csv','email','bank')),
  created_at   timestamptz not null default now(),
  unique (item_id, occurred_on, source),
  foreign key (item_id, household_id) references recurring_items(id, household_id) on delete cascade
);
create index item_amount_history_household_idx on item_amount_history(household_id);

-- ===== occurrences =====
create table occurrences (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references households(id) on delete cascade,
  item_id             uuid not null,
  scheduled_on        date not null,                  -- from the rule
  due_on              date not null,                  -- after weekend rule / manual move
  actual_amount_cents bigint check (actual_amount_cents >= 0),  -- set when a statement/actual arrives
  status              text not null default 'scheduled' check (status in ('scheduled','paid','received','skipped')),
  paid_on             date,
  marked_by           uuid references users(id),
  moved_by            uuid references users(id),
  version             int not null default 1,         -- If-Match concurrency (BACKEND_PLAN §5.1)
  unique (item_id, scheduled_on),
  foreign key (item_id, household_id) references recurring_items(id, household_id) on delete cascade,
  check (status not in ('paid','received') or paid_on is not null)  -- engine rule 7 needs the paid date
);
create index occurrences_household_due_idx on occurrences(household_id, due_on);
create trigger occurrences_bump_version before update on occurrences
  for each row execute function app_bump_version();

-- ===== planned_expenses =====
create table planned_expenses (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 80),
  amount_cents  bigint not null check (amount_cents > 0),
  due_on        date not null,
  owner_type    owner_type not null,
  owner_user_id uuid references users(id),
  goal_id       uuid,                                  -- paid from a goal (e.g. Tahoe trip)
  status        text not null default 'planned' check (status in ('planned','done','cancelled')),
  version       int not null default 1,                -- If-Match concurrency (BACKEND_PLAN §5.1)
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  check ((owner_type = 'member') = (owner_user_id is not null)),
  foreign key (goal_id, household_id) references goals(id, household_id),
  foreign key (household_id, owner_user_id) references household_members(household_id, user_id)
);
create index planned_expenses_household_idx on planned_expenses(household_id, due_on);
create trigger planned_expenses_bump_version before update on planned_expenses
  for each row execute function app_bump_version();

-- ===== balances (append-only history; the latest row is the runway's starting point) =====
create table balances (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  label        text not null default 'Checking' check (char_length(label) between 1 and 40),
  amount_cents bigint not null,
  as_of        date not null,
  source       text not null check (source in ('manual','csv','bank')),
  recorded_by  uuid references users(id),
  created_at   timestamptz not null default now()
);
create index balances_latest_idx on balances(household_id, as_of desc, created_at desc);

-- ===== Row-level security =====
-- mp_api: active member of the row's household. mp_worker: the job's household.
-- Rows the API creates are always hand-entered and attributed to the caller (G1 M-2, L-1): inserts must
-- have source = 'manual' and created_by / recorded_by = app_user_id(). CSV, email and bank sources are
-- written by their own pipelines as mp_worker.
do $$
declare
  t text;
begin
  foreach t in array array['goals','recurring_items','renewal_details','item_amount_history','planned_expenses','balances']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I on %I for all to mp_worker
      using (household_id = app_household_id()) with check (household_id = app_household_id())$p$,
      t || '_worker_job_scope', t);
    execute format($p$create policy %I on %I for select to mp_api using (app_is_household_member(household_id))$p$,
      t || '_api_select', t);
  end loop;
  -- update and delete for the tables the API may change (goals: read-only for mp_api until WP-13, Q-050)
  foreach t in array array['recurring_items','renewal_details','item_amount_history','planned_expenses','balances']
  loop
    execute format($p$create policy %I on %I for update to mp_api
      using (app_is_household_member(household_id)) with check (app_is_household_member(household_id))$p$,
      t || '_api_update', t);
    execute format($p$create policy %I on %I for delete to mp_api using (app_is_household_member(household_id))$p$,
      t || '_api_delete', t);
  end loop;
end
$$;

create policy recurring_items_api_insert on recurring_items for insert to mp_api
  with check (app_is_household_member(household_id) and source = 'manual' and created_by = app_user_id());
create policy renewal_details_api_insert on renewal_details for insert to mp_api
  with check (app_is_household_member(household_id));
create policy item_amount_history_api_insert on item_amount_history for insert to mp_api
  with check (app_is_household_member(household_id) and source = 'manual');
create policy planned_expenses_api_insert on planned_expenses for insert to mp_api
  with check (app_is_household_member(household_id) and created_by = app_user_id());
create policy balances_api_insert on balances for insert to mp_api
  with check (app_is_household_member(household_id) and source = 'manual' and recorded_by = app_user_id());

-- occurrences: one policy per command, so the delete policy can be narrower. Only an unpaid, still
-- `scheduled` row can be deleted (schedule rebuilds); paid, received and skipped history never is.
alter table occurrences enable row level security;
alter table occurrences force row level security;
create policy occurrences_api_select on occurrences for select to mp_api
  using (app_is_household_member(household_id));
create policy occurrences_api_insert on occurrences for insert to mp_api
  with check (app_is_household_member(household_id));
create policy occurrences_api_update on occurrences for update to mp_api
  using (app_is_household_member(household_id)) with check (app_is_household_member(household_id));
create policy occurrences_api_delete on occurrences for delete to mp_api
  using (app_is_household_member(household_id) and status = 'scheduled');
create policy occurrences_worker_select on occurrences for select to mp_worker
  using (household_id = app_household_id());
create policy occurrences_worker_insert on occurrences for insert to mp_worker
  with check (household_id = app_household_id());
create policy occurrences_worker_update on occurrences for update to mp_worker
  using (household_id = app_household_id()) with check (household_id = app_household_id());
create policy occurrences_worker_delete on occurrences for delete to mp_worker
  using (household_id = app_household_id() and status = 'scheduled');

-- ===== Grants (per command, per column for writes) =====
grant select on goals, recurring_items, renewal_details, item_amount_history, occurrences,
  planned_expenses, balances to mp_api, mp_worker;

-- goals: mp_api reads only. WP-13 adds write grants together with the proposal gate (Q-050). mp_worker may
-- insert so the seed and the RLS tests can create goals without a proposal.
grant insert (id, household_id, name, type, target_cents, saved_cents, monthly_cents, target_date, color_slot,
              is_emergency_fund, status, created_by) on goals to mp_worker;

-- recurring_items: never hard-deleted by the app (soft delete keeps undo and history).
grant insert (id, household_id, direction, kind, category, name, provider_name, provider_domain, amount_type,
              amount_cents, rrule, dtstart, until, weekend_rule, owner_type, owner_user_id, status, source,
              account_last4, paid_from, marked_possibly_unused, subcategory, movable, on_bills_page, notes,
              created_by) on recurring_items to mp_api, mp_worker;
grant update (kind, category, name, provider_name, provider_domain, amount_type, amount_cents, rrule, dtstart,
              until, weekend_rule, owner_type, owner_user_id, status, account_last4, paid_from,
              marked_possibly_unused, subcategory, movable, on_bills_page, notes, deleted_at)
  on recurring_items to mp_api;

grant insert (item_id, household_id, auto_renews, coverage_start, coverage_end, cancel_by, decision_by,
              shop_around_on, previous_amount_cents, price_changed_on, document_s3_key)
  on renewal_details to mp_api, mp_worker;
grant update (auto_renews, coverage_start, coverage_end, cancel_by, decision_by, shop_around_on,
              previous_amount_cents, price_changed_on, document_s3_key) on renewal_details to mp_api;
grant delete on renewal_details to mp_api;

-- Amount history is append-or-correct: no deletes.
grant insert (household_id, item_id, occurred_on, amount_cents, source) on item_amount_history to mp_api, mp_worker;
grant update (amount_cents) on item_amount_history to mp_api;

-- occurrences: the API marks, moves and rebuilds; the worker materializes (WP-06 job). Neither can change
-- household_id, item_id or scheduled_on, which identify the occurrence within its series.
grant insert (household_id, item_id, scheduled_on, due_on) on occurrences to mp_api, mp_worker;
grant update (due_on, actual_amount_cents, status, paid_on, marked_by, moved_by) on occurrences to mp_api, mp_worker;
grant delete on occurrences to mp_api, mp_worker;

-- planned_expenses are hard-deleted (BACKEND_PLAN §5.1).
grant insert (id, household_id, name, amount_cents, due_on, owner_type, owner_user_id, goal_id, status, created_by)
  on planned_expenses to mp_api;
grant update (name, amount_cents, due_on, owner_type, owner_user_id, goal_id, status) on planned_expenses to mp_api;
grant delete on planned_expenses to mp_api;

-- balances: append-only. The API writes manual balances; the CSV import (worker) writes its own source.
grant insert (household_id, label, amount_cents, as_of, source, recorded_by) on balances to mp_api, mp_worker;

-- ===== Household listing for schedulers (Q-051) =====
-- The nightly occurrences.materialize fan-out needs every household id, which no app role can read
-- (mp_worker is scoped to one household per job). Ids only, nothing else. Runs as mp_migrator through its
-- `households_definer_read` policy; executable by mp_worker only.
create function app_list_household_ids() returns setof uuid
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$ select h.id from public.households h order by h.id $$;
revoke all on function app_list_household_ids() from public;
grant execute on function app_list_household_ids() to mp_worker;
