-- WP-03 · G1 final fixes. Regression tests: test/rls/g1-final.test.ts (each failed before this file).

-- ===== final-2: no app role can un-revoke an invite =====
-- Restrictive, so it is ANDed with every permissive UPDATE policy for both app roles: a revoked invite
-- cannot be updated at all, and the only possible change to revoked_at is null -> a timestamp.
create policy invites_revoke_is_final on invites as restrictive for update to mp_api, mp_worker
  using (revoked_at is null)
  with check (revoked_at is not null);

-- ===== final-1 and final-3: app_accept_invite =====
-- Replaces the G1 version: assigns whichever colour role is free among active members, refuses a full
-- household (2 active members) or one scheduled for deletion with a clear reason, and serializes
-- concurrent accepts for the same household so the colour index never surfaces a raw 23505.
create or replace function app_accept_invite(p_token_hash bytea) returns uuid
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $$
declare
  v_user     uuid := public.app_user_id();
  v_email    text;
  v_inv      record;
  v_deleting timestamptz;
  v_active   int;
  v_colors   text[];
  v_color    text;
  v_rows     bigint;
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

  -- One accept at a time per household (released at commit/rollback).
  perform pg_advisory_xact_lock(hashtextextended('app_accept_invite:' || v_inv.household_id::text, 0));

  select h.deletion_scheduled_for into v_deleting from public.households h where h.id = v_inv.household_id;
  if v_deleting is not null then
    raise exception 'invite_household_deleting' using errcode = '42501';
  end if;

  if exists (select 1 from public.household_members m
              where m.household_id = v_inv.household_id and m.user_id = v_user and m.left_at is null) then
    raise exception 'invite_already_member' using errcode = '42501';
  end if;

  select count(*), coalesce(array_agg(m.color_role), '{}')
    into v_active, v_colors
    from public.household_members m
   where m.household_id = v_inv.household_id and m.left_at is null;
  if v_active >= 2 then
    raise exception 'invite_household_full' using errcode = '42501';
  end if;
  v_color := case when 'partnerA' = any (v_colors) then 'partnerB' else 'partnerA' end;

  insert into public.household_members as m (household_id, user_id, color_role, is_creator)
       values (v_inv.household_id, v_user, v_color, false)
  on conflict (household_id, user_id) do update
         set left_at = null, joined_at = now(), color_role = v_color, is_creator = false
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

-- CREATE OR REPLACE keeps the existing owner and grants (EXECUTE: mp_api only); restated for review.
revoke all on function app_accept_invite(bytea) from public;
grant execute on function app_accept_invite(bytea) to mp_api;
