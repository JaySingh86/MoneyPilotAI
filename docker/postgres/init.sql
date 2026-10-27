-- Local-only database roles (BACKEND_PLAN §5.3, ADR-003). Runs once when the volume is first created.
-- None of these roles is a superuser or has BYPASSRLS, so row-level security is really enforced,
-- including in tests. WP-03 adds grants and policies through migrations.

CREATE ROLE mp_migrator LOGIN PASSWORD 'mp_local_migrator' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE mp_api      LOGIN PASSWORD 'mp_local_api'      NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE mp_worker   LOGIN PASSWORD 'mp_local_worker'   NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE mp_analytics LOGIN PASSWORD 'mp_local_analytics' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;

-- The migrator owns the database and its public schema, so it creates tables and policies.
ALTER DATABASE moneypilot OWNER TO mp_migrator;
\connect moneypilot
ALTER SCHEMA public OWNER TO mp_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO mp_api, mp_worker, mp_analytics;
