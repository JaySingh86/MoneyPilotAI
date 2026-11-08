-- WP-21 · Email connections, message metadata and OAuth state (BACKEND_PLAN §5.2, §5.3, §7.8.1, §10). Expand-only.
--
-- Hard rule 7: no email bodies and no plaintext tokens. `email_messages` keeps metadata (provider id, received
-- time, sender domain, stage); the subject is stored only by the pipeline when an item was extracted. The
-- refresh token is stored envelope-encrypted (token_ciphertext, token_dek_wrapped, token_key_id).
--
-- Who may touch what (column grants are the second wall behind RLS):
--   email_connections  mp_api inserts a connection the signed-in member just authorised (sealing the token with
--                      encrypt-only crypto, so it holds INSERT but never SELECT on the three token columns) and
--                      lets the owner pause, resume or disconnect it. Only mp_worker can SELECT the token columns,
--                      and only it records sync state, watch state, and clears the token after revocation.
--   email_messages     mp_worker only writes; members read (counts on Email & imports).
--   email_oauth_states one row per connect attempt, user-scoped (a person belongs to one household at a time, so
--                      the household is looked up when the state is used). The API inserts; it can never read
--                      one back. `app_email_oauth_consume` deletes and returns it exactly once.
--
-- A disconnect keeps the row (status 'revoked', token columns emptied by the worker after it revoked at the
-- provider); the audit event is written by the API when the owner asks and by the worker when the token is gone.

create table email_connections (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references households(id) on delete cascade,
  user_id           uuid not null references users(id),     -- only this member can manage it
  provider          text not null check (provider in ('gmail','outlook')),
  address_masked    text not null check (char_length(address_masked) between 3 and 80),   -- "sam•••@gmail.com"
  address_hash      bytea not null check (octet_length(address_hash) = 32),               -- HMAC, no plaintext address
  scopes            text[] not null check (cardinality(scopes) between 1 and 10),
  token_ciphertext  bytea,                                   -- envelope-encrypted refresh token; null once revoked
  token_dek_wrapped bytea,
  token_key_id      text check (token_key_id is null or char_length(token_key_id) <= 200),
  status            text not null default 'active' check (status in ('active','paused','error','revoked')),
  sync_cursor       text check (sync_cursor is null or char_length(sync_cursor) <= 4000),  -- Gmail historyId / Graph deltaLink
  watch_ref         text check (watch_ref is null or char_length(watch_ref) <= 200),      -- Graph subscription id
  watch_expires_at  timestamptz,
  push_received_at  timestamptz,                             -- a verified push arrived; the sweep runs discover
  last_synced_at    timestamptz,
  last_error        text check (last_error is null or last_error in
                      ('auth_expired','provider_error','rate_limited','watch_failed','watch_expiring','revoked_by_provider')),
  backfill_months   int not null default 13 check (backfill_months between 1 and 24),
  backfill_status   text not null default 'pending' check (backfill_status in ('pending','running','done','failed')),
  backfill_cursor   text check (backfill_cursor is null or char_length(backfill_cursor) <= 4000),  -- resume point
  created_at        timestamptz not null default now(),
  revoked_at        timestamptz,
  unique (id, household_id),
  check (status = 'revoked' or (token_ciphertext is not null and token_dek_wrapped is not null and token_key_id is not null)),
  check ((status = 'revoked') = (revoked_at is not null))
);
-- One live connection per member, provider and mailbox; a revoked row does not block connecting again.
create unique index email_connections_live_uq on email_connections(household_id, user_id, provider, address_hash)
  where status <> 'revoked';
create index email_connections_household_idx on email_connections(household_id, created_at, id);
create index email_connections_hash_idx on email_connections(provider, address_hash) where status = 'active';

create table email_messages (                               -- one row per message we looked at; no bodies
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references households(id) on delete cascade,
  connection_id       uuid,
  channel             text not null check (channel in ('gmail','outlook','forward')),
  provider_message_id text not null check (char_length(provider_message_id) between 1 and 512),
  received_at         timestamptz not null,
  from_domain         text not null check (char_length(from_domain) between 1 and 255),
  subject             text check (subject is null or char_length(subject) <= 300),   -- only if an item was extracted
  stage               text not null check (stage in ('discovered','prefiltered_out','irrelevant','extracted','failed','quarantined')),
  truncated           boolean not null default false,
  processed_at        timestamptz,
  created_at          timestamptz not null default now(),
  unique (id, household_id),
  -- A connection must be in this household (an FK check is not subject to RLS). A removed connection keeps the rows.
  foreign key (connection_id, household_id) references email_connections(id, household_id) on delete set null (connection_id)
);
create unique index email_messages_uq on email_messages
  (channel, coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid), provider_message_id);
create index email_messages_household_idx on email_messages(household_id, received_at desc);
create index email_messages_connection_idx on email_messages(connection_id, stage);

create table email_oauth_states (
  state_hash    bytea primary key check (octet_length(state_hash) = 32),      -- sha256 of the random state
  user_id       uuid not null references users(id) on delete cascade,
  provider      text not null check (provider in ('gmail','outlook')),
  return_to     text not null check (return_to in ('/imports','/setup')),
  code_verifier text not null check (char_length(code_verifier) between 43 and 128),   -- PKCE (RFC 7636)
  browser_hash  bytea not null check (octet_length(browser_hash) = 32),               -- sha256 of the nonce in the starting browser's cookie
  expires_at    timestamptz not null,                                          -- 10 minutes (BACKEND_PLAN §7.8.1)
  created_at    timestamptz not null default now()
);
create index email_oauth_states_expiry_idx on email_oauth_states(expires_at);

-- ===== Row-level security =====
alter table email_connections enable row level security;
alter table email_connections force row level security;
alter table email_messages enable row level security;
alter table email_messages force row level security;
alter table email_oauth_states enable row level security;
alter table email_oauth_states force row level security;

-- Partners see that a connection exists (masked address, status); only its owner changes it.
create policy email_connections_api_select on email_connections for select to mp_api
  using (app_is_household_member(household_id));
create policy email_connections_api_insert on email_connections for insert to mp_api
  with check (app_is_household_member(household_id) and user_id = app_user_id() and status = 'active');
create policy email_connections_api_update on email_connections for update to mp_api
  using (app_is_household_member(household_id) and user_id = app_user_id())
  with check (app_is_household_member(household_id) and user_id = app_user_id());
create policy email_connections_worker_select on email_connections for select to mp_worker
  using (household_id = app_household_id());
create policy email_connections_worker_update on email_connections for update to mp_worker
  using (household_id = app_household_id()) with check (household_id = app_household_id());
-- The two push functions below run as mp_migrator.
create policy email_connections_definer_select on email_connections for select to mp_migrator using (true);
create policy email_connections_definer_update on email_connections for update to mp_migrator
  using (true) with check (true);

create policy email_messages_api_select on email_messages for select to mp_api
  using (app_is_household_member(household_id));
create policy email_messages_worker_job_scope on email_messages for all to mp_worker
  using (household_id = app_household_id()) with check (household_id = app_household_id());

create policy email_oauth_states_api_insert on email_oauth_states for insert to mp_api
  with check (user_id = app_user_id());
-- The worker can see and delete only expired states (the sweep prunes them); a live state is invisible to it. A
-- DELETE with a WHERE clause also needs a SELECT policy.
create policy email_oauth_states_worker_select on email_oauth_states for select to mp_worker
  using (expires_at < now());
create policy email_oauth_states_worker_delete on email_oauth_states for delete to mp_worker
  using (expires_at < now());
create policy email_oauth_states_definer on email_oauth_states for all to mp_migrator
  using (true) with check (true);

-- ===== Guard: what a person may do to a connection =====
-- Pause, resume, retry after an error, or disconnect (which needs `revoked_at`); nothing else changes through the API.
create function email_connections_guard() returns trigger language plpgsql
  set search_path = public, pg_temp as $$
begin
  if current_user = 'mp_api' then
    if new.status is distinct from old.status and not (
         (old.status = 'active' and new.status = 'paused')
      or (old.status in ('paused','error') and new.status = 'active')
      or (old.status in ('active','paused','error') and new.status = 'revoked')) then
      raise exception 'that connection change is not allowed' using errcode = '42501';
    end if;
    if old.status = 'revoked' then
      raise exception 'a disconnected mailbox cannot be changed' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;
create trigger email_connections_guard before update on email_connections
  for each row execute function email_connections_guard();

-- ===== Grants (per command, per column) =====
-- Everything the API needs to list and manage, and nothing of the token or the hash.
grant select (id, household_id, user_id, provider, address_masked, scopes, status, watch_expires_at,
              last_synced_at, last_error, backfill_months, backfill_status, created_at, revoked_at)
  on email_connections to mp_api;
grant insert (id, household_id, user_id, provider, address_masked, address_hash, scopes, token_ciphertext,
              token_dek_wrapped, token_key_id, status)
  on email_connections to mp_api;
grant update (status, revoked_at) on email_connections to mp_api;
-- The worker reads everything, including the ciphertext columns (BACKEND_PLAN §5.3), and records what it did.
grant select on email_connections to mp_worker;
grant update (status, sync_cursor, watch_ref, watch_expires_at, push_received_at, last_synced_at, last_error,
              backfill_status, backfill_cursor, token_ciphertext, token_dek_wrapped, token_key_id, revoked_at)
  on email_connections to mp_worker;

grant select on email_messages to mp_api;
grant select, delete on email_messages to mp_worker;
grant insert (id, household_id, connection_id, channel, provider_message_id, received_at, from_domain, subject,
              stage, truncated, processed_at)
  on email_messages to mp_worker;
grant update (subject, stage, truncated, processed_at) on email_messages to mp_worker;

grant insert (state_hash, user_id, provider, return_to, code_verifier, browser_hash, expires_at)
  on email_oauth_states to mp_api;
grant delete on email_oauth_states to mp_worker;
grant select (expires_at) on email_oauth_states to mp_worker;

-- ===== Definer functions =====
-- The OAuth callback is a browser redirect from the provider and carries no sign-in, only the state and a cookie set
-- when the flow started. This deletes the state (so it works once, and a wrong attempt burns it), refuses an expired
-- one or one whose browser nonce does not match (login CSRF: a link someone else started), and returns who started it
-- and their current household. Nothing else about a person or a household is reachable through it.
create function app_email_oauth_consume(p_state_hash bytea, p_browser_hash bytea)
  returns table (user_id uuid, household_id uuid, provider text, return_to text, code_verifier text)
  language plpgsql security definer
  set search_path = public, pg_temp as $$
declare
  s email_oauth_states%rowtype;
begin
  delete from email_oauth_states o where o.state_hash = p_state_hash returning * into s;
  if not found or s.expires_at <= now() or p_browser_hash is distinct from s.browser_hash then
    return;
  end if;
  return query
    select s.user_id,
           (select m.household_id from household_members m
             where m.user_id = s.user_id and m.left_at is null order by m.joined_at limit 1),
           s.provider, s.return_to, s.code_verifier;
end
$$;
revoke all on function app_email_oauth_consume(bytea, bytea) from public;
grant execute on function app_email_oauth_consume(bytea, bytea) to mp_api;

-- A verified Gmail push names a mailbox, not a household. Marks the matching active connections so the next
-- sweep runs discover for them; returns how many matched. The caller has already verified Google's token.
create function app_email_push_gmail(p_address_hash bytea) returns integer
  language plpgsql security definer
  set search_path = public, pg_temp as $$
declare
  n integer;
begin
  update email_connections c set push_received_at = now()
   where c.provider = 'gmail' and c.address_hash = p_address_hash and c.status = 'active';
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function app_email_push_gmail(bytea) from public;
grant execute on function app_email_push_gmail(bytea) to mp_api;

-- A Graph notification carries our own clientState (an HMAC naming the connection), verified by the caller.
create function app_email_push_graph(p_connection_id uuid) returns integer
  language plpgsql security definer
  set search_path = public, pg_temp as $$
declare
  n integer;
begin
  update email_connections c set push_received_at = now()
   where c.id = p_connection_id and c.provider = 'outlook' and c.status = 'active';
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function app_email_push_graph(uuid) from public;
grant execute on function app_email_push_graph(uuid) to mp_api;
