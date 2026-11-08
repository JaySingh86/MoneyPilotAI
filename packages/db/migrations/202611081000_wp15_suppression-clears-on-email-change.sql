-- WP-15 fix round (Q-133): a bounced or complained address stays suppressed until the person's email address
-- changes. app_sync_auth_user is what mirrors the verified address into users.email, so it also clears
-- notification_preferences.email_suppressed_* when (and only when) the address actually changes. The same
-- address synced again leaves the suppression in place. Everything else is unchanged from the WP-05 version
-- (own-subject check, worker-only delete, signature and grants).

create or replace function app_sync_auth_user(p_auth_subject text, p_email text, p_mfa_enabled boolean, p_deleted boolean)
  returns boolean
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $$
declare
  v_is_worker boolean := pg_has_role(session_user, 'mp_worker', 'member');
  v_user_id   uuid;
  v_old_email public.citext;
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

  select u.id, u.email into v_user_id, v_old_email
    from public.users u
   where u.auth_subject = p_auth_subject
     and (v_is_worker or u.deleted_at is null)
   for update;
  if not found then
    return false;
  end if;

  update public.users
     set email = p_email,
         mfa_enabled = p_mfa_enabled,
         deleted_at = case when p_deleted then coalesce(deleted_at, now()) else deleted_at end
   where id = v_user_id;

  -- a change of letter case alone is not a new address (users.email is citext; the function's search_path does
  -- not include the schema of citext's operators, so compare lowered text)
  if lower(v_old_email::text) is distinct from lower(p_email) then
    update public.notification_preferences
       set email_suppressed_at = null, email_suppressed_reason = null
     where user_id = v_user_id
       and email_suppressed_at is not null;
  end if;
  return true;
end
$$;

revoke all on function app_sync_auth_user(text, text, boolean, boolean) from public;
grant execute on function app_sync_auth_user(text, text, boolean, boolean) to mp_api, mp_worker;
