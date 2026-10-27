-- WP-03 · G1 security review hardening (docs/agents/QUESTIONS.md Q-011, Q-012, Q-013).
-- Every change here has a regression test in test/rls/g1-hardening.test.ts or
-- test/integration/audit-purge.test.ts that failed before this migration.

-- ===== Owner policies used by SECURITY DEFINER functions =====
-- The definer functions below run as mp_migrator, which owns these tables and is still under FORCE RLS.
-- These policies give it nothing it lacks as owner (it could disable RLS); they only let the narrow
-- functions work. No app role can act as mp_migrator. Future data backfills in migrations also need an
-- explicit migrator policy (Q-011).
create policy invites_definer_read on invites for select to mp_migrator using (true);
create policy invites_definer_update on invites for update to mp_migrator using (true) with check (true);
create policy household_members_definer_insert on household_members for insert to mp_migrator
  with check (true);
create policy household_members_definer_update on household_members for update to mp_migrator
  using (true) with check (true);
create policy users_definer_update on users for update to mp_migrator using (true) with check (true);
create policy audit_events_definer_all on audit_events for all to mp_migrator using (true) with check (true);

-- ===== G1-1 (HIGH): invite acceptance only through app_accept_invite =====
-- mp_api may now insert a membership only as the creator of a household with no members yet.
drop policy household_members_api_insert on household_members;
create policy household_members_api_insert on household_members for insert to mp_api
  with check (user_id = app_user_id() and is_creator and app_household_unclaimed_by_me(household_id));

-- Invite updates: members may revoke an unaccepted invite; the invitee may only decline an open one.
-- Every WITH CHECK requires revoked_at to be set, so nobody can un-revoke, and accepted_at is no longer
-- writable by mp_api at all.
drop policy invites_api_update on invites;
revoke update (accepted_at) on invites from mp_api;
create policy invites_api_member_revoke on invites for update to mp_api
  using (app_is_household_member(household_id) and accepted_at is null)
  with check (app_is_household_member(household_id) and revoked_at is not null);
create policy invites_api_invitee_decline on invites for update to mp_api
  using (email = app_user_email() and accepted_at is null and revoked_at is null)
  with check (email = app_user_email() and revoked_at is not null and accepted_at is null);

-- Accept an invite by the sha256 of its emailed token, atomically: checks it is open and addressed to the
-- signed-in user's email, then joins as partnerB (or re-joins after leaving), marks it accepted and
-- writes the audit event. Failures raise SQLSTATE 42501 with message invite_<reason>.
create function app_accept_invite(p_token_hash bytea) returns uuid
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $$
declare
  v_user  uuid := public.app_user_id();
  v_email text;
  v_inv   record;
  v_rows  bigint;
begin
  if v_user is null then
    raise exception 'invite_not_signed_in' using errcode = '42501';
  end if;
  select u.email::text into v_email from public.users u where u.id = v_user and u.deleted_at is null;

  select i.id, i.household_id, i.email::text as email, i.expires_at, i.accepted_at, i.revoked_at
    into v_inv
    from public.invites i
   where i.token_hash = p_token_hash
     for update;
  if not found then
    raise exception 'invite_not_found' using errcode = '42501';
  elsif v_inv.accepted_at is not null then
    raise exception 'invite_accepted' using errcode = '42501';
  elsif v_inv.revoked_at is not null then
    raise exception 'invite_revoked' using errcode = '42501';
  elsif v_inv.expires_at <= now() then
    raise exception 'invite_expired' using errcode = '42501';
  elsif v_email is null or lower(v_inv.email) <> lower(v_email) then
    raise exception 'invite_mismatch' using errcode = '42501';
  end if;

  insert into public.household_members as m (household_id, user_id, color_role, is_creator)
       values (v_inv.household_id, v_user, 'partnerB', false)
  on conflict (household_id, user_id) do update
         set left_at = null, joined_at = now(), color_role = 'partnerB', is_creator = false
       where m.left_at is not null;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'invite_already_member' using errcode = '42501';
  end if;

  update public.invites set accepted_at = now() where id = v_inv.id;
  insert into public.audit_events (household_id, actor_user_id, actor_type, action, entity_type, entity_id)
       values (v_inv.household_id, v_user, 'user', 'invite.accepted', 'invite', v_inv.id);
  return v_inv.household_id;
end
$$;

-- ===== G1-6 / Q-013: invite lookup for the accept page =====
-- Same rule as @mp/format maskEmail: at most 3 characters of the local part, always hiding at least one.
create function app_mask_email(p_email text) returns text
  language sql immutable parallel safe
  set search_path = pg_catalog, pg_temp
  as $$
    select case when s.local_part is null or s.local_part = '' or s.domain = '' then null
                else left(s.local_part, least(3, char_length(s.local_part) - 1)) || '•••@' || s.domain
           end
      from (select substring(p_email from '^(.*)@[^@]*$') as local_part,
                   substring(p_email from '@([^@]*)$') as domain) s
  $$;

-- Possession of the emailed token reveals only the invite's status and its masked address, so the API
-- can say "sign in with sam•••@gmail.com". No household, inviter or id is returned.
create function app_invite_lookup(p_token_hash bytea) returns table (status text, masked_email text)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select case
             when i.accepted_at is not null then 'accepted'
             when i.revoked_at is not null then 'revoked'
             when i.expires_at <= now() then 'expired'
             when u.email is null or lower(u.email::text) <> lower(i.email::text) then 'mismatch'
             else 'valid'
           end,
           public.app_mask_email(i.email::text)
      from public.invites i
      left join public.users u on u.id = public.app_user_id() and u.deleted_at is null
     where i.token_hash = p_token_hash
  $$;

revoke all on function app_accept_invite(bytea), app_invite_lookup(bytea), app_mask_email(text) from public;
grant execute on function app_accept_invite(bytea), app_invite_lookup(bytea), app_mask_email(text) to mp_api;

-- ===== G1-2 (MEDIUM) and G1-4 (LOW): users =====
-- mp_api can no longer choose a user id, set or change the email after bootstrap, set the MFA flag or
-- touch deleted_at. Bootstrap still inserts the verified email; later changes come from the auth provider.
revoke insert (id, mfa_enabled) on users from mp_api;
revoke update (email, mfa_enabled, deleted_at) on users from mp_api;

-- Applies an auth-provider (Clerk) user event, after the webhook was verified and handed to a job.
-- Deletion is one-way: it never clears deleted_at. Returns false if no user has that subject.
create function app_sync_auth_user(p_auth_subject text, p_email text, p_mfa_enabled boolean, p_deleted boolean)
  returns boolean
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $$
begin
  if p_auth_subject is null or p_email is null or p_mfa_enabled is null or p_deleted is null then
    raise exception 'app_sync_auth_user: arguments must not be null' using errcode = '22004';
  end if;
  update public.users
     set email = p_email,
         mfa_enabled = p_mfa_enabled,
         deleted_at = case when p_deleted then coalesce(deleted_at, now()) else deleted_at end
   where auth_subject = p_auth_subject;
  return found;
end
$$;
revoke all on function app_sync_auth_user(text, text, boolean, boolean) from public;
grant execute on function app_sync_auth_user(text, text, boolean, boolean) to mp_worker;

-- ===== G1-4 (LOW): households =====
-- The forwarding address is rotated later through a dedicated path, not a plain column update.
revoke update (forwarding_token) on households from mp_api;

-- A deletion can be scheduled only at least 7 days ahead (BACKEND_PLAN §7.11), or cancelled (null).
-- A trigger rather than a policy: the rule applies only when the value changes, so unrelated edits
-- during the 7-day window keep working. One minute of tolerance for app/DB clock skew.
create function app_guard_deletion_schedule() returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
begin
  if new.deletion_scheduled_for is not null
     and new.deletion_scheduled_for is distinct from old.deletion_scheduled_for
     and new.deletion_scheduled_for < now() + interval '7 days' - interval '1 minute' then
    raise exception 'deletion_scheduled_for must be at least 7 days ahead' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function app_guard_deletion_schedule() from public;
create trigger households_guard_deletion_schedule before update of deletion_scheduled_for on households
  for each row execute function app_guard_deletion_schedule();

-- ===== G1-4 (LOW): idempotency purge reads keys, never stored responses =====
revoke select on idempotency_keys from mp_worker;
grant select (user_id, key, created_at) on idempotency_keys to mp_worker;

-- ===== G1-5 / Q-012: audit retention and tombstones =====
-- audit_events stays append-only for every app role; this function is the only way rows change.
alter table audit_events add column tombstoned_at timestamptz;

-- retention.purge (mp_worker): delete events older than 2 years; reduce events of deleted households to a
-- tombstone (household_id, action, actor_type, time) and delete tombstones 1 year after tombstoning.
create function app_purge_audit_events() returns table (purged bigint, tombstoned bigint)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $$
declare
  v_purged bigint := 0;
  v_tombstoned bigint := 0;
  v_rows bigint;
begin
  delete from public.audit_events a where a.created_at < now() - interval '2 years';
  get diagnostics v_rows = row_count;
  v_purged := v_rows;

  delete from public.audit_events a where a.tombstoned_at < now() - interval '1 year';
  get diagnostics v_rows = row_count;
  v_purged := v_purged + v_rows;

  update public.audit_events a
     set actor_user_id = null, entity_type = null, entity_id = null, metadata = '{}'::jsonb,
         ip = null, user_agent = null, tombstoned_at = now()
   where a.household_id is not null
     and a.tombstoned_at is null
     and not exists (select 1 from public.households h where h.id = a.household_id);
  get diagnostics v_tombstoned = row_count;

  return query select v_purged, v_tombstoned;
end
$$;
revoke all on function app_purge_audit_events() from public;
grant execute on function app_purge_audit_events() to mp_worker;
