-- WP-16 · CSV import: imports, transactions, saved column mappings (BACKEND_PLAN §5.2, §7.7). Expand-only.
--
-- Hard rule 7: the raw file is deleted after processing (`s3_key` cleared, `purged_at` set); a transaction keeps a
-- description with long digit runs already masked to their last 4 and a formula-neutralised text (the worker does
-- both before insert), and `account_label` holds at most the last 4 characters. `columns` keeps only the header
-- row of the file, never a data row.
--
-- Who writes what:
--   imports          mp_api creates the row for an upload (uploaded_by = the caller), and may only move it to
--                    `processing` (after the upload, or after a mapping is chosen). mp_worker records everything
--                    the processing produced: status, fingerprint, headers, counts, balance, error, purge.
--   transactions     mp_worker only (insert, delete for the 13-month purge); members may read their household's.
--   import_mappings  mp_api saves the mapping a member chose for a header fingerprint; mp_worker reads it.

create table imports (
  id                   uuid primary key default gen_random_uuid(),
  household_id         uuid not null references households(id) on delete cascade,
  uploaded_by          uuid not null references users(id),
  s3_key               text,                                    -- cleared after processing
  filename             text not null check (char_length(filename) between 1 and 120),
  size_bytes           bigint check (size_bytes is null or size_bytes between 0 and 10485760),
  status               text not null check (status in ('uploaded','needs_mapping','processing','done','failed')),
  mapping              jsonb check (mapping is null or jsonb_typeof(mapping) = 'object'),
  fingerprint          text check (fingerprint is null or char_length(fingerprint) <= 2000),
  columns              jsonb check (columns is null or (jsonb_typeof(columns) = 'array' and jsonb_array_length(columns) <= 100)),
  row_count            int check (row_count is null or row_count >= 0),
  added_count          int check (added_count is null or added_count >= 0),
  duplicate_count      int check (duplicate_count is null or duplicate_count >= 0),
  rejected_count       int check (rejected_count is null or rejected_count >= 0),
  detected_count       int check (detected_count is null or detected_count >= 0),
  queued_count         int check (queued_count is null or queued_count >= 0),
  latest_balance_cents bigint,
  latest_balance_on    date,
  error                text check (error is null or error in
                         ('too_large','empty','no_rows','too_many_rows','too_many_columns','bad_encoding',
                          'parse_failed','missing_file','bad_mapping')),
  created_at           timestamptz not null default now(),
  processed_at         timestamptz,
  purged_at            timestamptz,
  unique (id, household_id)
);
create index imports_household_idx on imports(household_id, created_at desc, id);
create index imports_processing_idx on imports(household_id) where status = 'processing';

create table transactions (                                       -- kept 13 months for recurring detection, then purged
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  import_id     uuid,
  posted_on     date not null,
  description   text not null check (char_length(description) <= 200),
  merchant_norm text not null check (char_length(merchant_norm) <= 60),
  amount_cents  bigint not null check (amount_cents between -100000000000 and 100000000000),  -- negative = outflow
  account_label text check (account_label is null or char_length(account_label) <= 8),
  dedupe_hash   bytea not null check (octet_length(dedupe_hash) = 32),
  unique (household_id, dedupe_hash),
  -- An import must be in this household (an FK check is not subject to RLS). Purging an import keeps the rows.
  foreign key (import_id, household_id) references imports(id, household_id) on delete set null (import_id)
);
create index transactions_merchant_idx on transactions(household_id, merchant_norm, posted_on);
create index transactions_posted_idx on transactions(household_id, posted_on);

create table import_mappings (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  fingerprint  text not null check (char_length(fingerprint) between 1 and 2000),
  mapping      jsonb not null check (jsonb_typeof(mapping) = 'object'),
  created_by   uuid references users(id),
  updated_at   timestamptz not null default now(),
  unique (household_id, fingerprint)
);

-- WP-14 left `extracted_items.import_id` without a foreign key until this table existed (tenant-safe, like match_item_id).
alter table extracted_items add constraint extracted_items_import_fk
  foreign key (import_id, household_id) references imports(id, household_id) on delete set null (import_id);

-- The API only moves an import forward to `processing`; every other status is the worker's to record, so a
-- member cannot mark a file `done` or rewrite what processing found.
create function imports_guard() returns trigger language plpgsql
  set search_path = public, pg_temp as $$
begin
  if current_user = 'mp_api' then
    if new.status is distinct from old.status and not (
         new.status = 'processing' and old.status in ('uploaded','needs_mapping')) then
      raise exception 'an import can only be queued for processing by a person' using errcode = '42501';
    end if;
    if new.mapping is distinct from old.mapping and old.status <> 'needs_mapping' then
      raise exception 'a mapping can only be chosen while the import needs one' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;
create trigger imports_guard before update on imports for each row execute function imports_guard();

-- ===== Row-level security =====
alter table imports enable row level security;
alter table imports force row level security;
alter table transactions enable row level security;
alter table transactions force row level security;
alter table import_mappings enable row level security;
alter table import_mappings force row level security;

create policy imports_worker_job_scope on imports for all to mp_worker
  using (household_id = app_household_id()) with check (household_id = app_household_id());
create policy imports_api_select on imports for select to mp_api
  using (app_is_household_member(household_id));
create policy imports_api_insert on imports for insert to mp_api
  with check (app_is_household_member(household_id) and uploaded_by = app_user_id() and status = 'uploaded');
create policy imports_api_update on imports for update to mp_api
  using (app_is_household_member(household_id)) with check (app_is_household_member(household_id));

create policy transactions_worker_job_scope on transactions for all to mp_worker
  using (household_id = app_household_id()) with check (household_id = app_household_id());
-- Read-only for members (RLS-scoped); no API route returns raw rows today. The API cannot insert, update or delete.
create policy transactions_api_select on transactions for select to mp_api
  using (app_is_household_member(household_id));

create policy import_mappings_worker_select on import_mappings for select to mp_worker
  using (household_id = app_household_id());
create policy import_mappings_api_select on import_mappings for select to mp_api
  using (app_is_household_member(household_id));
create policy import_mappings_api_insert on import_mappings for insert to mp_api
  with check (app_is_household_member(household_id) and created_by = app_user_id());
create policy import_mappings_api_update on import_mappings for update to mp_api
  using (app_is_household_member(household_id)) with check (app_is_household_member(household_id));

-- ===== Grants (per command, per column for writes) =====
grant select on imports to mp_api, mp_worker;
grant insert (id, household_id, uploaded_by, s3_key, filename, size_bytes, status) on imports to mp_api;
grant update (status, mapping) on imports to mp_api;
grant update (status, mapping, fingerprint, columns, row_count, added_count, duplicate_count, rejected_count,
              detected_count, queued_count, latest_balance_cents, latest_balance_on, error, s3_key, processed_at, purged_at)
  on imports to mp_worker;

grant select on transactions to mp_api;
grant select, delete on transactions to mp_worker;
grant insert (id, household_id, import_id, posted_on, description, merchant_norm, amount_cents, account_label, dedupe_hash)
  on transactions to mp_worker;

grant select on import_mappings to mp_api, mp_worker;
grant insert (household_id, fingerprint, mapping, created_by) on import_mappings to mp_api;
grant update (mapping, created_by, updated_at) on import_mappings to mp_api;
