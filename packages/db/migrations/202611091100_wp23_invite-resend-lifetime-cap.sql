-- WP-23 review fix: a resend never keeps an invite alive past 30 days from when it was first sent. A rollback after
-- a failed send still restores the exact previous expiry (`p_expires_at` given). Same signature and grants.
create or replace function app_rotate_invite_token(
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
  select i.id, i.token_hash, i.accepted_at, i.revoked_at, i.expires_at, i.created_at
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
     set token_hash = p_token_hash,
         expires_at = coalesce(p_expires_at, least(now() + interval '7 days', v_inv.created_at + interval '30 days'))
   where id = v_inv.id;
  return 'ok';
end
$$;
