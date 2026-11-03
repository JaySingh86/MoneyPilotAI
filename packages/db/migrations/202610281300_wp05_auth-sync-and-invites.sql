-- WP-05 · Auth sync for Cognito (ADR-017), one household per user (Q-085), creator transfer on leave.
--
-- ===== app_sync_auth_user =====
-- It becomes callable by mp_api, from POST /v1/me/bootstrap only. There are no auth webhooks any more: the
-- API syncs email and MFA from a verified access token whose email_verified claim is true (the API checks
-- that claim; the database cannot see the token).
--
-- SECURITY NOTE: invite security depends on this function's own-subject check. An invite is accepted by
-- comparing the invite email with users.email (app_accept_invite, app_invite_lookup, the membership
-- policies). If mp_api could set users.email for any subject, anyone could take over any invited address.
-- So the checks are fail-CLOSED: they apply to every caller except the worker (a role member check on the
-- login role, so `SET ROLE mp_api` from another login, or a future API role, is still restricted):
--   * the subject must be the request's own verified subject (app.auth_subject, set by withHouseholdTx
--     from the verified token),
--   * p_deleted must be false,
--   * a deleted user is never touched.
-- mp_worker (account deletion from the worker, ADR-017) is the only exemption.
-- CREATE OR REPLACE keeps the owner and the existing mp_worker grant.

create or replace function app_sync_auth_user(p_auth_subject text, p_email text, p_mfa_enabled boolean, p_deleted boolean)
  returns boolean
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $$
declare
  v_is_worker boolean := pg_has_role(session_user, 'mp_worker', 'member');
begin
  if p_auth_subject is null or p_email is null or p_mfa_enabled is null or p_deleted is null then
    raise exception 'app_sync_auth_user: arguments must not be null' using errcode = '22004';
  end if;
  if not v_is_worker then
    if p_deleted then
      raise exception 'app_sync_auth_user: only the worker can delete users' using errcode = '42501';
    end if;
    if p_auth_subject is distinct from public.app_auth_subject() then
      raise exception 'app_sync_auth_user: subject is not the caller''s own' using errcode = '42501';
    end if;
  end if;
  update public.users
     set email = p_email,
         mfa_enabled = p_mfa_enabled,
         deleted_at = case when p_deleted then coalesce(deleted_at, now()) else deleted_at end
   where auth_subject = p_auth_subject
     and (v_is_worker or deleted_at is null);
  return found;
end
$$;

revoke all on function app_sync_auth_user(text, text, boolean, boolean) from public;
grant execute on function app_sync_auth_user(text, text, boolean, boolean) to mp_api, mp_worker;

-- ===== One active household per user (Q-085, BACKEND_PLAN §6) =====
-- Creating or accepting into a second household while an active membership exists violates this index (the
-- API checks first and answers 409; the index closes the race). Leaving frees it.
create unique index household_members_one_active_uq on household_members(user_id) where left_at is null;

-- ===== Creator transfer on leave (BACKEND_PLAN §6, "billing owner (the creator, transferable)") =====
-- mp_api may only update its own membership row, so handing is_creator to the partner needs a definer
-- function. It does exactly one thing: when the caller is the active creator and exactly one other active
-- member exists, move is_creator to that member. Returns the new creator's user id, or null (no change).
create policy household_members_definer_creator on household_members for update to mp_migrator
  using (true) with check (true);

create function app_transfer_creator(p_household uuid) returns uuid
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $$
declare
  v_user  uuid := public.app_user_id();
  v_other uuid;
begin
  if v_user is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  if not exists (select 1 from public.household_members m
                  where m.household_id = p_household and m.user_id = v_user
                    and m.left_at is null and m.is_creator) then
    return null;
  end if;
  select m.user_id into v_other
    from public.household_members m
   where m.household_id = p_household and m.user_id <> v_user and m.left_at is null
   order by m.joined_at
   limit 1;
  if v_other is null then
    return null;
  end if;
  update public.household_members m
     set is_creator = (m.user_id = v_other)
   where m.household_id = p_household and m.left_at is null and m.user_id in (v_user, v_other);
  return v_other;
end
$$;

revoke all on function app_transfer_creator(uuid) from public;
grant execute on function app_transfer_creator(uuid) to mp_api;
