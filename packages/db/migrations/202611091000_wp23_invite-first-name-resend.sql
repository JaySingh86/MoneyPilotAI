-- WP-23 fix round (Q-179): an invite may carry the invitee's first name (so setup can say "Jordan invited"),
-- and "Resend" replaces the open invite's token in place. Expand only: one nullable column, one function.
alter table invites add column first_name text check (first_name is null or char_length(first_name) between 1 and 50);
grant insert (first_name) on invites to mp_api;

-- The G1 policies let mp_api change an invite only to revoke it, and `invites_revoke_is_final` forbids anything
-- else, so the token cannot be rotated with a plain UPDATE. This SECURITY DEFINER function is the one way:
-- the caller must be a member of the household, the invite must still be open, and (when `p_expect_hash` is
-- given, for rolling back a failed send) the token must still be the one the caller expects. `p_expires_at`
-- null means "7 days from now". Returns 'ok', 'missing' or 'closed'.
create function app_rotate_invite_token(
  p_household_id uuid, p_invite_id uuid, p_token_hash bytea, p_expires_at timestamptz, p_expect_hash bytea
) returns text
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $$
declare
  v_inv record;
begin
  if not public.app_is_household_member(p_household_id) then
    return 'missing';
  end if;
  select i.id, i.token_hash, i.accepted_at, i.revoked_at, i.expires_at
    into v_inv
    from public.invites i
   where i.id = p_invite_id and i.household_id = p_household_id
     for update;
  if not found then
    return 'missing';
  end if;
  if v_inv.accepted_at is not null or v_inv.revoked_at is not null then
    return 'closed';
  end if;
  if p_expect_hash is null then
    if v_inv.expires_at <= now() then
      return 'closed';
    end if;
  elsif v_inv.token_hash <> p_expect_hash then
    return 'closed';
  end if;
  update public.invites
     set token_hash = p_token_hash, expires_at = coalesce(p_expires_at, now() + interval '7 days')
   where id = v_inv.id;
  return 'ok';
end
$$;
revoke all on function app_rotate_invite_token(uuid, uuid, bytea, timestamptz, bytea) from public;
grant execute on function app_rotate_invite_token(uuid, uuid, bytea, timestamptz, bytea) to mp_api;
