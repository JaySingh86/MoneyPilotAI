-- WP-14 · Review queue, applied changes (undo log) and sender rules (BACKEND_PLAN §5.2, §7.8.2, §8.2). Expand-only.
--
-- Hard rule 7: nothing here stores an email body. `extracted_items` keeps the validated fields, evidence quotes
-- taken from the REDACTED text (140 characters each), the rule-check results and the message id. The subject
-- and sender domain are kept in `message_meta` only because an item was extracted (BACKEND_PLAN §5.2).
--
-- Who writes what:
--   extracted_items   mp_worker inserts (email pipeline WP-22, CSV import WP-16) and may update every decision
--                     column (auto-apply, expiry). mp_api only decides: state, decided_by/at, fields (edit) and
--                     applied_change_id.
--   applied_changes   mp_api inserts the row for a confirmed item (applied_by = the caller); mp_worker inserts
--                     automatic ones (applied_by null). Only undone_at / undone_by can change afterwards.
--   sender_rules      rows with household_id null are the global seed list: readable by every member and job,
--                     writable by nobody at runtime. A household manages its own rows.

create table extracted_items (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references households(id) on delete cascade,
  source            text not null check (source in ('email','csv')),
  -- email_messages is created by WP-20 (connections). WP-20 adds the foreign key when its table lands (Q-120).
  message_id        uuid,
  import_id         uuid,
  extractor_version text not null,                         -- prompt + schema version
  model_id          text,
  fields            jsonb not null check (jsonb_typeof(fields) = 'object'),
  -- The fields as extracted, kept when a person edits them, so a consented eval feed is possible later (Q-126).
  original_fields   jsonb check (original_fields is null or jsonb_typeof(original_fields) = 'object'),
  evidence_stale    boolean not null default false,       -- true after an edit: the quotes describe the original
  evidence          jsonb not null check (jsonb_typeof(evidence) = 'array'),
  checks            jsonb not null check (jsonb_typeof(checks) = 'object'),
  -- {fromDomain, subject, receivedAt}: what the review card shows as "where it came from". No body, ever.
  -- Exactly these keys and nothing else, so a body can never ride along (M1). The pipeline redacts the subject
  -- (WP-19) before writing; the API masks digit runs again when it reads.
  message_meta      jsonb check (message_meta is null or (
                      jsonb_typeof(message_meta) = 'object'
                      and (message_meta - 'fromDomain' - 'subject' - 'receivedAt') = '{}'::jsonb
                      and coalesce(jsonb_typeof(message_meta -> 'fromDomain'), '') = 'string'
                      and char_length(message_meta ->> 'fromDomain') <= 253
                      and coalesce(jsonb_typeof(message_meta -> 'receivedAt'), '') = 'string'
                      and coalesce(jsonb_typeof(message_meta -> 'subject'), 'null') in ('string', 'null')
                      and char_length(coalesce(message_meta ->> 'subject', '')) <= 300)),
  match_item_id     uuid,
  match_type        text not null check (match_type in ('new','update','decision','duplicate')),
  state             text not null default 'queued'
                      check (state in ('queued','auto_applied','confirmed','edited','ignored','expired')),
  decided_by        uuid references users(id),
  decided_at        timestamptz,
  applied_change_id uuid,
  created_at        timestamptz not null default now(),
  unique (id, household_id),
  -- A matched item must be in this household (an FK check is not subject to RLS). Soft deletes keep the row.
  foreign key (match_item_id, household_id) references recurring_items(id, household_id)
    on delete set null (match_item_id)
);
create index extracted_items_queue_idx on extracted_items(household_id, created_at, id) where state = 'queued';
create index extracted_items_household_state_idx on extracted_items(household_id, state, created_at);

create table applied_changes (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  origin       text not null check (origin in ('email','csv','proposal','user','engine')),
  entity_type  text not null check (char_length(entity_type) between 1 and 40),
  entity_id    uuid not null,
  before       jsonb,
  after        jsonb not null,
  applied_by   uuid references users(id),                  -- null = automatic
  applied_at   timestamptz not null default now(),
  undo_until   timestamptz,                                -- applied_at + 30 days
  undone_at    timestamptz,
  undone_by    uuid references users(id),
  unique (id, household_id),
  check ((undone_at is null) = (undone_by is null)),
  -- A change to an item always has an object to restore from and to compare with (L1).
  check (entity_type <> 'item' or (jsonb_typeof(after) = 'object' and (before is null or jsonb_typeof(before) = 'object')))
);
create index applied_changes_household_idx on applied_changes(household_id, applied_at desc, id);

alter table extracted_items add constraint extracted_items_applied_change_fk
  foreign key (applied_change_id, household_id) references applied_changes(id, household_id)
  on delete set null (applied_change_id);

create table sender_rules (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid references households(id) on delete cascade,   -- null = global seed list
  domain        text not null check (
                  char_length(domain) between 3 and 253
                  and domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  rule          text not null check (rule in ('watch','ignore')),
  category_hint text,
  created_by    uuid references users(id),
  unique (household_id, domain)
);
create unique index sender_rules_global_domain_uq on sender_rules(domain) where household_id is null;

-- A decision moves a queued item once: state only leaves `queued`, a decided row's fields do not change, and a
-- person can only record a decision as themselves (L3).
create function extracted_items_guard() returns trigger language plpgsql
  set search_path = public, pg_temp as $$
begin
  if old.state <> 'queued' and (new.state is distinct from old.state or new.fields is distinct from old.fields) then
    raise exception 'a decided review item cannot change' using errcode = '23514';
  end if;
  if current_user = 'mp_api' and new.state is distinct from old.state and new.decided_by is distinct from app_user_id() then
    raise exception 'a decision is recorded as the caller' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger extracted_items_guard before update on extracted_items
  for each row execute function extracted_items_guard();

-- ===== Row-level security =====
alter table extracted_items enable row level security;
alter table extracted_items force row level security;
alter table applied_changes enable row level security;
alter table applied_changes force row level security;
alter table sender_rules enable row level security;
alter table sender_rules force row level security;

create policy extracted_items_worker_job_scope on extracted_items for all to mp_worker
  using (household_id = app_household_id()) with check (household_id = app_household_id());
create policy extracted_items_api_select on extracted_items for select to mp_api
  using (app_is_household_member(household_id));
create policy extracted_items_api_update on extracted_items for update to mp_api
  using (app_is_household_member(household_id)) with check (app_is_household_member(household_id));

create policy applied_changes_worker_job_scope on applied_changes for all to mp_worker
  using (household_id = app_household_id()) with check (household_id = app_household_id());
create policy applied_changes_api_select on applied_changes for select to mp_api
  using (app_is_household_member(household_id));
create policy applied_changes_api_insert on applied_changes for insert to mp_api
  with check (app_is_household_member(household_id) and applied_by = app_user_id() and undone_at is null);
create policy applied_changes_api_update on applied_changes for update to mp_api
  using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id) and undone_by = app_user_id());

-- sender_rules: the global list (household_id null) is readable, never writable by an app role.
create policy sender_rules_worker_select on sender_rules for select to mp_worker
  using (household_id is null or household_id = app_household_id());
create policy sender_rules_worker_insert on sender_rules for insert to mp_worker
  with check (household_id = app_household_id());
create policy sender_rules_api_select on sender_rules for select to mp_api
  using (household_id is null or app_is_household_member(household_id));
create policy sender_rules_api_insert on sender_rules for insert to mp_api
  with check (household_id is not null and app_is_household_member(household_id) and created_by = app_user_id());
create policy sender_rules_api_update on sender_rules for update to mp_api
  using (household_id is not null and app_is_household_member(household_id))
  with check (household_id is not null and app_is_household_member(household_id));
create policy sender_rules_api_delete on sender_rules for delete to mp_api
  using (household_id is not null and app_is_household_member(household_id));

-- Items created from a review (Q-124). mp_api's general insert policy stays manual-only; this second policy lets
-- the API insert an `email` or `csv` item only inside a transaction that names (app.review_item_id, set by the
-- server) a still-queued extracted item of the SAME household whose source is the item's source. The client never
-- chooses the source.
create policy recurring_items_api_insert_review on recurring_items for insert to mp_api
  with check (
    app_is_household_member(household_id) and created_by = app_user_id() and source in ('email','csv')
    and exists (
      select 1 from extracted_items e
       where e.id = nullif(current_setting('app.review_item_id', true), '')::uuid
         and e.household_id = recurring_items.household_id
         and e.state = 'queued'
         and e.source = recurring_items.source));

-- ===== Grants (per command, per column for writes) =====
-- Undoing an actual amount removes the history point it wrote (Q-122); WP-06 granted no delete.
grant delete on item_amount_history to mp_api;

grant select on extracted_items, applied_changes, sender_rules to mp_api, mp_worker;

grant insert (id, household_id, source, message_id, import_id, extractor_version, model_id, fields, original_fields,
              evidence_stale, evidence, checks, message_meta, match_item_id, match_type, state, decided_by, decided_at, applied_change_id)
  on extracted_items to mp_worker;
grant update (fields, evidence, checks, match_item_id, match_type, state, decided_by, decided_at, applied_change_id)
  on extracted_items to mp_worker;
-- The API only decides: it can correct fields (edit) and move the state, nothing about where the item came from.
grant update (fields, original_fields, evidence_stale, state, decided_by, decided_at, applied_change_id)
  on extracted_items to mp_api;

grant insert (id, household_id, origin, entity_type, entity_id, before, after, applied_by, applied_at, undo_until)
  on applied_changes to mp_api, mp_worker;
grant update (undone_at, undone_by) on applied_changes to mp_api;

grant insert (household_id, domain, rule, category_hint, created_by) on sender_rules to mp_api, mp_worker;
grant update (rule, category_hint) on sender_rules to mp_api;
grant delete on sender_rules to mp_api;
