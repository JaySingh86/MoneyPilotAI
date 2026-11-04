-- WP-25 · Billing: subscriptions, the billing event inbox, and the two functions that connect the API's
-- webhook to the worker (BACKEND_PLAN §7.10, §8.4; ADR-013). Expand-only: two new tables, two functions.
--
-- Why this shape. `households.plan` stays writable only by mp_worker (WP-03). A webhook arrives at the API
-- with no user and no household session, and the API has no queue connection yet (Q-105). So the API does
-- exactly one thing with a verified webhook: it calls `app_billing_ingest`, which records the event id in
-- `webhook_events` (the dedupe) and the normalized event in `billing_events` in one statement. The worker
-- (`billing.sync`) applies the events to `subscriptions` and `households.plan` under its own household
-- scope. mp_api gets no table privilege on either table, and no way to name a plan.

-- ===== subscriptions: one row per household =====
create table subscriptions (
  household_id             uuid primary key references households(id) on delete cascade,
  provider                 text not null check (char_length(provider) between 1 and 40),
  provider_customer_id     text not null check (char_length(provider_customer_id) between 1 and 120),
  provider_subscription_id text not null check (char_length(provider_subscription_id) between 1 and 120),
  status                   text not null check (status in ('trialing','active','past_due','canceled','expired')),
  billing_interval         text not null check (billing_interval in ('month','year')),
  current_period_end       timestamptz,
  cancel_at_period_end     boolean not null default false,
  last_event_at            timestamptz not null,   -- occurred_at of the newest applied event; older ones are stale
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);

alter table subscriptions enable row level security;
alter table subscriptions force row level security;

-- Members may read their household's subscription (state only; the API never returns provider ids).
create policy subscriptions_api_select on subscriptions for select to mp_api
  using (app_is_household_member(household_id));
-- The worker owns every write, for the household the job is scoped to.
create policy subscriptions_worker_select on subscriptions for select to mp_worker
  using (household_id = app_household_id());
create policy subscriptions_worker_insert on subscriptions for insert to mp_worker
  with check (household_id = app_household_id());
create policy subscriptions_worker_update on subscriptions for update to mp_worker
  using (household_id = app_household_id())
  with check (household_id = app_household_id());

grant select on subscriptions to mp_api, mp_worker;
grant insert (household_id, provider, provider_customer_id, provider_subscription_id, status,
              billing_interval, current_period_end, cancel_at_period_end, last_event_at)
  on subscriptions to mp_worker;
grant update (provider, provider_customer_id, provider_subscription_id, status, billing_interval,
              current_period_end, cancel_at_period_end, last_event_at, updated_at)
  on subscriptions to mp_worker;

-- ===== billing_events: verified webhooks waiting for the worker =====
-- Holds ids and states only (no card data, names or amounts). The payload is the normalized event.
create table billing_events (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  provider     text not null check (char_length(provider) between 1 and 40),
  event_id     text not null check (char_length(event_id) between 1 and 200),
  type         text not null check (char_length(type) between 1 and 80),
  occurred_at  timestamptz not null,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  outcome      text check (outcome in ('applied','stale','ignored')),
  unique (provider, event_id)
);
create index billing_events_pending_idx on billing_events (household_id, occurred_at) where processed_at is null;

alter table billing_events enable row level security;
alter table billing_events force row level security;

-- mp_api may read its household's events (ids and states only) but never write: it can only enqueue through
-- app_billing_ingest.
create policy billing_events_api_select on billing_events for select to mp_api
  using (app_is_household_member(household_id));
create policy billing_events_worker_select on billing_events for select to mp_worker
  using (household_id = app_household_id());
create policy billing_events_worker_update on billing_events for update to mp_worker
  using (household_id = app_household_id())
  with check (household_id = app_household_id());

grant select on billing_events to mp_api, mp_worker;
grant update (processed_at, outcome) on billing_events to mp_worker;

-- ===== Definer policies: the two functions below run as mp_migrator =====
create policy billing_events_definer_insert on billing_events for insert to mp_migrator with check (true);
create policy billing_events_definer_select on billing_events for select to mp_migrator using (true);
create policy subscriptions_definer_select on subscriptions for select to mp_migrator using (true);
create policy webhook_events_definer_all on webhook_events for all to mp_migrator using (true) with check (true);

-- ===== app_billing_ingest: the API's only way to hand a verified billing webhook to the worker =====
-- The signature is already proven by the route, but this function still refuses what a real provider would
-- never send, so a leaked signing secret or a provider bug cannot pin the plan (WP-25 review M2):
--   * occurred_at more than 5 minutes ahead of the database clock (a far-future date would make every real
--     event look stale);
--   * a provider, event id or type that is not a plain identifier, and a payload that is not
--     {"subscription": {providerCustomerId, providerSubscriptionId, status, interval, ...}} with known values.
-- A refusal raises SQLSTATE 42501 with message billing_event_invalid and records nothing, so the event id is
-- not consumed. Otherwise: the provider event id goes in webhook_events; a repeat returns false and changes
-- nothing. A new event for a household that exists is queued in billing_events. An event for an unknown
-- household is marked processed at once (nothing to apply, and a retry must not loop). Returns true when new.
create function app_billing_ingest(
  p_provider text, p_event_id text, p_household uuid, p_type text, p_occurred_at timestamptz, p_payload jsonb
) returns boolean
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $$
declare
  v_new bigint;
  v_sub jsonb := p_payload -> 'subscription';
begin
  if p_occurred_at is null or p_occurred_at > now() + interval '5 minutes'
     or p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{0,39}$'
     or p_event_id is null or char_length(p_event_id) not between 1 and 200
     or p_type is null or char_length(p_type) > 80 or p_type !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
     or p_payload is null or jsonb_typeof(p_payload) is distinct from 'object'
     or octet_length(p_payload::text) > 4000
     or jsonb_typeof(v_sub) is distinct from 'object'
     or coalesce(v_sub ->> 'status', '') not in ('trialing','active','past_due','canceled','expired')
     or coalesce(v_sub ->> 'interval', '') not in ('month','year')
     or char_length(coalesce(v_sub ->> 'providerCustomerId', '')) not between 1 and 120
     or char_length(coalesce(v_sub ->> 'providerSubscriptionId', '')) not between 1 and 120
  then
    raise exception 'billing_event_invalid' using errcode = '42501';
  end if;

  insert into public.webhook_events (provider, event_id) values (p_provider, p_event_id)
    on conflict do nothing;
  get diagnostics v_new = row_count;
  if v_new = 0 then
    return false;
  end if;
  if exists (select 1 from public.households h where h.id = p_household) then
    insert into public.billing_events (household_id, provider, event_id, type, occurred_at, payload)
      values (p_household, p_provider, p_event_id, p_type, p_occurred_at, p_payload);
  else
    update public.webhook_events set processed_at = now()
      where provider = p_provider and event_id = p_event_id;
  end if;
  return true;
end
$$;
revoke all on function app_billing_ingest(text, text, uuid, text, timestamptz, jsonb) from public;
grant execute on function app_billing_ingest(text, text, uuid, text, timestamptz, jsonb) to mp_api;

-- ===== app_billing_pending_households: which households need a billing.sync (ids only) =====
-- Two reasons: a queued event, or a plan that no longer matches its subscription without any new webhook
-- (a canceled subscription whose paid period has ended, or an expired one, while households.plan is still
-- family_plus). Runs as mp_migrator through its definer-read policies; executable by mp_worker only.
create function app_billing_pending_households() returns setof uuid
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select b.household_id from public.billing_events b where b.processed_at is null
    union
    select s.household_id
      from public.subscriptions s join public.households h on h.id = s.household_id
     where h.plan = 'family_plus'
       and (s.status = 'expired'
            or (s.status = 'canceled' and (s.current_period_end is null or s.current_period_end <= now())))
  $$;
revoke all on function app_billing_pending_households() from public;
grant execute on function app_billing_pending_households() to mp_worker;
