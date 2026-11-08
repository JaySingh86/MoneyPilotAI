-- MoneyPilot bootstrap for a Supabase Postgres project (ADR-020, WP-32).
-- Run once as `postgres` (the Supabase admin user) through `pnpm db:bootstrap:supabase`, which sets the session
-- settings below. Safe to run again at any time: every statement is idempotent.
--
-- Session settings (set by the CLI with set_config; never part of this file):
--   mp.pw_<role>   password for that role. Empty = leave the role's password unchanged.
--
-- What it does, and why (docs/runbooks/supabase-setup.md):
--   1. Creates the four login roles plus mp_analytics. None is a superuser, has BYPASSRLS or can create roles,
--      so forced row-level security applies to every one of them (ADR-003).
--   2. Lets mp_migrator run `pnpm db:migrate` WITHOUT owning the database and without database-level CREATE:
--      CREATE on schema public (tables, functions, types) and ownership of the `pgboss` schema, which this script
--      creates. The migrator owns what it creates, as locally, and cannot add schemas or touch Supabase's own.
--      Before anything else the script refuses an existing mp_* role with elevated attributes or memberships.
--   3. Pre-creates citext in `public`, where a plain `create extension citext` puts it on a vanilla database, so
--      WP-03's `create extension if not exists citext` is a no-op and `public.citext` resolves the same way it
--      does locally (the SECURITY DEFINER functions pin search_path to pg_catalog and write `public.citext`).
--      pgcrypto already lives in Supabase's `extensions` schema.
--   4. Takes everything away from anon, authenticated and service_role (the Data API roles). The Data API is
--      also switched off in the dashboard; this is the second lock.

-- ===== 1. Refuse a pre-existing role that is more than it should be =====
-- Runs BEFORE any password is set or anything is granted. `postgres` is not a superuser on Supabase, so it cannot
-- strip attributes from an existing role; one made by hand with extra rights must be dropped by the owner.
-- Besides the attributes, a role that is a member of another role (for example pg_read_all_data) would inherit
-- its rights around row-level security, so that is refused too.
do $bootstrap$
declare
  r record;
begin
  for r in
    select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
           exists (select 1 from pg_auth_members m where m.member = pg_roles.oid) as is_member
    from pg_roles
    where rolname in ('mp_migrator', 'mp_api', 'mp_worker', 'mp_queue', 'mp_analytics')
  loop
    if r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication then
      raise exception 'role % exists with SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION; drop it and run the bootstrap again', r.rolname
        using errcode = '42501';
    end if;
    if r.is_member then
      raise exception 'role % is a member of another role (pg_auth_members); drop it and run the bootstrap again', r.rolname
        using errcode = '42501';
    end if;
  end loop;
end
$bootstrap$;

-- ===== 2. Roles =====
-- Passwords come from session settings, so they never appear in this file. With statement logging
-- (log_statement = all/ddl) the server log can still contain the `alter role ... password` text: leave
-- log_statement at its default (none) on the project while bootstrapping, and rotate afterwards if in doubt.
do $bootstrap$
declare
  r text;
  pw text;
begin
  foreach r in array array['mp_migrator', 'mp_api', 'mp_worker', 'mp_queue'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I login nosuperuser nobypassrls nocreaterole nocreatedb noreplication', r);
    end if;
    pw := coalesce(current_setting('mp.pw_' || r, true), '');
    if pw <> '' then
      execute format('alter role %I password %L', r, pw);
    end if;
  end loop;

  -- Named by WP-03's migrations (`revoke ... from mp_analytics`); reserved for read-only reporting. Cannot log in.
  if not exists (select 1 from pg_roles where rolname = 'mp_analytics') then
    create role mp_analytics nologin nosuperuser nobypassrls nocreaterole nocreatedb noreplication;
  end if;
end
$bootstrap$;

-- ===== 3. Schema rights for the migrator =====
-- No database-level CREATE: the one schema the migrations add (the pg-boss queue) is created here, owned by the
-- migrator, and the migration's `create schema if not exists` finds it. The migrator can add objects inside
-- `public` and `pgboss` only.
do $bootstrap$
begin
  execute format('grant connect on database %I to mp_migrator, mp_api, mp_worker, mp_queue', current_database());
  execute format('revoke create on database %I from mp_migrator', current_database());
end
$bootstrap$;
-- Creating a schema for another owner needs SET on that role; grant it for this one statement only.
grant mp_migrator to current_user with set true, inherit false;
create schema if not exists pgboss authorization mp_migrator;
revoke set option for mp_migrator from current_user;

grant usage, create on schema public to mp_migrator;
grant usage on schema public to mp_api, mp_worker, mp_analytics;

-- ===== 4. Extensions =====
create schema if not exists extensions;
do $bootstrap$
declare
  ext_schema text;
begin
  select n.nspname into ext_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'citext';
  if ext_schema is null then
    create extension citext schema public;
  elsif ext_schema <> 'public' then
    alter extension citext set schema public;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    create extension pgcrypto schema extensions;
  end if;
end
$bootstrap$;
grant usage on schema extensions to mp_migrator;
-- Resolve extension functions (pgcrypto) the way Supabase's own roles do. citext is in public.
alter role mp_migrator set search_path = public, extensions;

-- ===== 5. Data API roles get nothing of ours =====
-- PUBLIC keeps no usage on public either (a vanilla database is set up the same way, init.sql), so a role that
-- is only a member of PUBLIC, which is every Supabase API role, cannot even resolve our object names.
revoke all on schema public from public;
do $bootstrap$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema public from %I', r);
      -- Our objects belong to mp_migrator, whose default privileges give these roles nothing (WP-03 also revokes
      -- PUBLIC's EXECUTE), so there is nothing to revoke on them. Supabase does grant these roles default
      -- privileges for objects `postgres` creates here. We never create objects as postgres; make sure none
      -- appears by accident.
      execute format('alter default privileges for role %I in schema public revoke all on tables from %I', current_user, r);
      execute format('alter default privileges for role %I in schema public revoke all on sequences from %I', current_user, r);
      execute format('alter default privileges for role %I in schema public revoke all on functions from %I', current_user, r);
    end if;
  end loop;
end
$bootstrap$;
