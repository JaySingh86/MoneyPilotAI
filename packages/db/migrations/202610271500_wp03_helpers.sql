-- WP-03 · Extensions, session helpers and trigger helpers (BACKEND_PLAN §5.1, §5.3; ADR-003).
-- Runs as mp_migrator, which owns every object. Roles themselves (mp_api, mp_worker, mp_migrator,
-- mp_analytics) are created outside migrations: docker/postgres/init.sql locally, infra in AWS.

create extension if not exists pgcrypto;
create extension if not exists citext;

-- New functions are not executable by PUBLIC; every grant below is explicit.
alter default privileges for role mp_migrator revoke execute on functions from public;
-- Tables and sequences already default to no privileges for other roles; each migration grants
-- per role, per command (and per column where it matters).

-- ===== Session context =====
-- withHouseholdTx / withJobTx set these with set_config(..., true) (= SET LOCAL) per transaction.
-- app.user_id       the signed-in user (mp_api).
-- app.household_id  the household a job runs for (mp_worker). Informational only for mp_api.
-- app.auth_subject  the verified auth-provider subject, before a users row id is known (bootstrap).

create function app_user_id() returns uuid
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create function app_household_id() returns uuid
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.household_id', true), '')::uuid $$;

create function app_auth_subject() returns text
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.auth_subject', true), '') $$;

revoke all on function app_user_id(), app_household_id(), app_auth_subject() from public;
grant execute on function app_user_id(), app_household_id(), app_auth_subject() to mp_api, mp_worker;

-- ===== Trigger helpers =====
-- Optimistic concurrency (BACKEND_PLAN §5.1, §8.1): every UPDATE bumps `version` by exactly one,
-- whatever the statement tried to set, so If-Match checks can trust it.
create function app_bump_version() returns trigger
  language plpgsql
  as $$
begin
  new.version := old.version + 1;
  return new;
end
$$;

create function app_touch_updated_at() returns trigger
  language plpgsql
  as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Trigger functions run as part of the triggering statement; app roles never call them directly.
revoke all on function app_bump_version(), app_touch_updated_at() from public;
