-- WP-03 · Identity and household tables, their RLS policies and grants (BACKEND_PLAN §5.2, §5.3, §6).
--
-- RLS model (ADR-003):
--   mp_api     sees a household only through an active membership of app_user_id().
--   mp_worker  sees exactly one household per job: app_household_id().
--   mp_migrator owns the tables. FORCE RLS applies to it too; its only policies are read-only
--              `*_definer_read` policies so the SECURITY DEFINER helpers below can answer questions
--              about the current user without recursive policies.
-- Every table has RLS enabled AND forced. Grants are per command and, for writes, per column.

-- ===== Tables =====
create table users (
  id            uuid primary key default gen_random_uuid(),
  auth_subject  text not null unique,              -- auth provider (Clerk) user id
  email         citext not null unique,
  first_name    text not null,
  last_name     text,
  timezone      text not null default 'America/New_York',
  mfa_enabled   boolean not null default false,    -- mirrored from auth webhook
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table households (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (char_length(name) between 1 and 80),
  timezone               text not null,
  currency               char(3) not null default 'USD',
  cushion_cents          bigint not null default 50000 check (cushion_cents >= 0),
  primary_income_item_id uuid,                     -- FK to recurring_items added by WP-06
  plan                   text not null default 'free' check (plan in ('free','family_plus')),
  forwarding_token       text not null unique,      -- local part, e.g. "rivera-7k2"
  created_by             uuid not null references users(id),
  deletion_scheduled_for timestamptz,
  version                int not null default 1,    -- If-Match concurrency (BACKEND_PLAN §5.1)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create trigger households_bump_version before update on households
  for each row execute function app_bump_version();
create trigger households_touch_updated_at before update on households
  for each row execute function app_touch_updated_at();

create table household_members (
  household_id uuid not null references households(id) on delete cascade,
  user_id      uuid not null references users(id),
  color_role   text not null check (color_role in ('partnerA','partnerB')),
  is_creator   boolean not null default false,
  joined_at    timestamptz not null default now(),
  left_at      timestamptz,
  primary key (household_id, user_id)
);
create unique index household_members_color_uq on household_members(household_id, color_role) where left_at is null;
create index household_members_user_idx on household_members(user_id) where left_at is null;

create table invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  email        citext not null,
  token_hash   bytea not null unique,                -- sha256 of the random token; token only in email link
  invited_by   uuid not null references users(id),
  expires_at   timestamptz not null,                 -- 7 days
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index invites_household_idx on invites(household_id);
create index invites_email_idx on invites(email);

-- ===== Membership helpers =====
-- SECURITY DEFINER so policies can ask about membership without recursing into household_members'
-- own policy. They run as mp_migrator (the owner), which is still under FORCE RLS and can read these
-- tables only through the `*_definer_read` policies below. They return a boolean about the current
-- user only, never row data. search_path is pinned against hijacking.

create function app_is_household_member(target_household uuid) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select exists (
      select 1 from public.household_members m
       where m.household_id = target_household
         and m.user_id = public.app_user_id()
         and m.left_at is null)
  $$;

-- True only while the current user's freshly created household has no membership rows at all,
-- i.e. the one moment the creator may insert their own partnerA membership.
create function app_household_unclaimed_by_me(target_household uuid) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select exists (
      select 1 from public.households h
       where h.id = target_household
         and h.created_by = public.app_user_id()
         and not exists (select 1 from public.household_members m where m.household_id = h.id))
  $$;

-- The current user's own email. SECURITY DEFINER for the same reason: invites and membership
-- policies use it, and reading users through users RLS would recurse into household_members.
create function app_user_email() returns public.citext
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$ select u.email from public.users u where u.id = public.app_user_id() $$;

revoke all on function app_is_household_member(uuid), app_household_unclaimed_by_me(uuid), app_user_email() from public;
grant execute on function app_is_household_member(uuid), app_household_unclaimed_by_me(uuid), app_user_email() to mp_api;

-- ===== users =====
alter table users enable row level security;
alter table users force row level security;

-- Self (by id once known, by auth subject during bootstrap) and anyone who shares a household with
-- the current user (partners see each other's names). household_members RLS limits the subquery.
create policy users_api_select on users for select to mp_api
  using (id = app_user_id()
         or auth_subject = app_auth_subject()
         or exists (select 1 from household_members m
                     where m.user_id = users.id and app_is_household_member(m.household_id)));
-- Bootstrap: a user row can only be created for the verified auth subject of the request.
create policy users_api_insert on users for insert to mp_api
  with check (auth_subject = app_auth_subject());
create policy users_api_update on users for update to mp_api
  using (id = app_user_id() or auth_subject = app_auth_subject())
  with check (id = app_user_id() or auth_subject = app_auth_subject());
-- Jobs read the members (current or former) of the household they run for.
create policy users_worker_select on users for select to mp_worker
  using (exists (select 1 from household_members m
                  where m.user_id = users.id and m.household_id = app_household_id()));
create policy users_definer_read on users for select to mp_migrator
  using (true);

grant select on users to mp_api, mp_worker;
grant insert (id, auth_subject, email, first_name, last_name, timezone, mfa_enabled) on users to mp_api;
grant update (email, first_name, last_name, timezone, mfa_enabled, deleted_at) on users to mp_api;

-- ===== households =====
alter table households enable row level security;
alter table households force row level security;

create policy households_api_select on households for select to mp_api
  using (app_is_household_member(id));
-- Create: only as yourself. The creator is not a member until the membership row is inserted in the
-- same transaction, so the API supplies the id and must not use INSERT ... RETURNING here.
create policy households_api_insert on households for insert to mp_api
  with check (created_by = app_user_id());
create policy households_api_update on households for update to mp_api
  using (app_is_household_member(id))
  with check (app_is_household_member(id));
-- Jobs: their own household only (deletion.execute deletes it; billing.sync updates plan).
create policy households_worker_access on households for all to mp_worker
  using (id = app_household_id())
  with check (id = app_household_id());
create policy households_definer_read on households for select to mp_migrator
  using (true);

grant select on households to mp_api, mp_worker;
-- `plan` is deliberately not writable by mp_api: entitlements change only through billing.sync (worker).
grant insert (id, name, timezone, currency, cushion_cents, forwarding_token, created_by) on households to mp_api;
grant update (name, timezone, cushion_cents, primary_income_item_id, forwarding_token, deletion_scheduled_for)
  on households to mp_api;
grant update (plan, deletion_scheduled_for) on households to mp_worker;
grant delete on households to mp_worker;

-- ===== household_members =====
alter table household_members enable row level security;
alter table household_members force row level security;

-- Members see every membership row of their households; anyone sees their own rows.
create policy household_members_api_select on household_members for select to mp_api
  using (user_id = app_user_id() or app_is_household_member(household_id));
-- Join only as yourself, and only (a) as the creator of a household that has no members yet, or
-- (b) as a non-creator holding an open invite addressed to your email.
create policy household_members_api_insert on household_members for insert to mp_api
  with check (
    user_id = app_user_id()
    and (
      (is_creator and app_household_unclaimed_by_me(household_id))
      or (not is_creator and exists (
            select 1 from invites i
             where i.household_id = household_members.household_id
               and i.email = app_user_email()
               and i.accepted_at is null
               and i.revoked_at is null
               and i.expires_at > now()))
    ));
-- Leave: a member can set left_at on their own active membership only.
create policy household_members_api_update on household_members for update to mp_api
  using (user_id = app_user_id() and left_at is null)
  with check (user_id = app_user_id());
create policy household_members_worker_access on household_members for all to mp_worker
  using (household_id = app_household_id())
  with check (household_id = app_household_id());
create policy household_members_definer_read on household_members for select to mp_migrator
  using (true);

grant select on household_members to mp_api, mp_worker;
grant insert (household_id, user_id, color_role, is_creator) on household_members to mp_api;
grant update (left_at) on household_members to mp_api, mp_worker;

-- ===== invites =====
alter table invites enable row level security;
alter table invites force row level security;

-- Members see their household's invites. An invitee sees not-yet-accepted invites addressed to their
-- own email (needed to accept, and to report expired/revoked ones); once accepted, only membership
-- grants access, so a member who later leaves loses it.
create policy invites_api_select on invites for select to mp_api
  using (app_is_household_member(household_id)
         or (email = app_user_email() and accepted_at is null));
create policy invites_api_insert on invites for insert to mp_api
  with check (app_is_household_member(household_id) and invited_by = app_user_id());
-- Accepting sets accepted_at after the membership row exists, so the new row passes as a member.
create policy invites_api_update on invites for update to mp_api
  using (app_is_household_member(household_id)
         or (email = app_user_email() and accepted_at is null))
  with check (app_is_household_member(household_id)
              or (email = app_user_email() and accepted_at is null));
create policy invites_worker_access on invites for all to mp_worker
  using (household_id = app_household_id())
  with check (household_id = app_household_id());

grant select on invites to mp_api, mp_worker;
grant insert (id, household_id, email, token_hash, invited_by, expires_at) on invites to mp_api;
grant update (accepted_at, revoked_at) on invites to mp_api;
grant update (revoked_at) on invites to mp_worker;
