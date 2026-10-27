-- WP-03 · Platform tables: audit log, API idempotency keys, webhook dedupe (BACKEND_PLAN §5.2, §5.3).

-- ===== audit_events =====
create table audit_events (
  id            bigserial primary key,
  household_id  uuid,                                     -- no FK: survives household deletion until purge window
  actor_user_id uuid,
  actor_type    text not null check (actor_type in ('user','system','support')),
  action        text not null,                             -- e.g. 'email.connected', 'item.updated', 'export.requested'
  entity_type   text,
  entity_id     uuid,
  metadata      jsonb not null default '{}',               -- never secrets or amounts beyond what the UI shows
  ip            inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);
create index audit_events_household_idx on audit_events(household_id, created_at desc);

alter table audit_events enable row level security;
alter table audit_events force row level security;

-- Members read their household's log; a user reads their own household-less events.
create policy audit_events_api_select on audit_events for select to mp_api
  using (app_is_household_member(household_id)
         or (household_id is null and actor_user_id = app_user_id()));
-- The API records events only as the signed-in user, for a household they belong to (or none).
create policy audit_events_api_insert on audit_events for insert to mp_api
  with check (actor_type = 'user'
              and actor_user_id = app_user_id()
              and (household_id is null or app_is_household_member(household_id)));
create policy audit_events_worker_select on audit_events for select to mp_worker
  using (household_id = app_household_id());
create policy audit_events_worker_insert on audit_events for insert to mp_worker
  with check (household_id = app_household_id());

-- Append-only for app roles (BACKEND_PLAN §5.3): no UPDATE/DELETE/TRUNCATE grant and no UPDATE or
-- DELETE policy, so even a future accidental grant would match zero rows.
revoke update, delete, truncate on audit_events from mp_api, mp_worker, mp_analytics;
grant select on audit_events to mp_api, mp_worker;
grant insert (household_id, actor_user_id, actor_type, action, entity_type, entity_id, metadata, ip, user_agent)
  on audit_events to mp_api, mp_worker;
grant usage on sequence audit_events_id_seq to mp_api, mp_worker;

-- ===== idempotency_keys (user-scoped, not household-scoped) =====
create table idempotency_keys (
  key          text not null,
  user_id      uuid not null,
  request_hash bytea not null,
  response     jsonb,
  status_code  int,
  created_at   timestamptz not null default now(),
  primary key (user_id, key)
);                                                          -- purged after 24h
create index idempotency_keys_created_idx on idempotency_keys(created_at);

alter table idempotency_keys enable row level security;
alter table idempotency_keys force row level security;

create policy idempotency_keys_api_access on idempotency_keys for all to mp_api
  using (user_id = app_user_id())
  with check (user_id = app_user_id());
-- retention.purge: the worker may see and delete only keys older than 24 hours.
create policy idempotency_keys_worker_purge on idempotency_keys for select to mp_worker
  using (created_at < now() - interval '24 hours');
create policy idempotency_keys_worker_delete on idempotency_keys for delete to mp_worker
  using (created_at < now() - interval '24 hours');

grant select, insert, delete on idempotency_keys to mp_api;
grant update (response, status_code) on idempotency_keys to mp_api;
grant select, delete on idempotency_keys to mp_worker;

-- ===== webhook_events (provider dedupe; no tenant or personal data) =====
create table webhook_events (
  provider     text not null,
  event_id     text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  primary key (provider, event_id)
);

-- Forced RLS like every other table. Webhooks arrive before any user or household is known, and the
-- rows hold only provider + event id, so both app roles get an explicit allow-all policy.
alter table webhook_events enable row level security;
alter table webhook_events force row level security;

create policy webhook_events_api_access on webhook_events for all to mp_api
  using (true) with check (true);
create policy webhook_events_worker_access on webhook_events for all to mp_worker
  using (true) with check (true);

grant select, insert on webhook_events to mp_api;
grant update (processed_at) on webhook_events to mp_api, mp_worker;
grant select on webhook_events to mp_worker;
