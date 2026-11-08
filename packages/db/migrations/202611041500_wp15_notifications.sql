-- WP-15 · Reminders and notifications (BACKEND_PLAN §5.2, §7.6, §9; ARCHITECTURE §4.4). Expand-only.
--
-- Who writes what:
--   notifications              mp_worker plans reminders and sends; mp_api inserts the in-app notifications a
--                              member's action causes for the OTHER member (proposal, task, review, system;
--                              never a reminder) and marks its own rows read. A member reads only their own rows.
--   notification_deliveries    mp_worker only (one row per notification and channel); mp_api reads its own.
--   notification_preferences   one row per user (not a household table). The user edits email_enabled and
--                              muted_kinds; email_suppressed_* is written only by app_record_delivery_event()
--                              when SES reports a hard bounce or a complaint.
--   reminder_rules             a member of the household edits; jobs read.
--   send_quota_events          per-user send quota for the invite email (packages/notify, Q-081); the user's own.
--
-- Deviations from the BACKEND_PLAN §5.2 sketch (recorded in QUESTIONS.md):
--   * dedupe_key is unique per household (the key carries uuids; a global unique would let one tenant probe another).
--   * reminders are keyed on (item, scheduled date, offset, user) as DESIGN_SPEC §6 rule 12 says, and the row keeps
--     item_id / scheduled_on / offset_days / due_on, so moving an occurrence updates the same row in place and the
--     dispatcher can check a reminder against the live occurrence before it sends.
--   * notification_deliveries carries household_id (hard rule 3).

-- ===== reminder_rules =====
create table reminder_rules (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references households(id) on delete cascade,
  item_id             uuid,                                   -- null = the household default
  offsets_days        int[] not null default '{3,0}'
                        check (cardinality(offsets_days) between 1 and 6
                               and 0 <= all (offsets_days) and 60 >= all (offsets_days)),
  channels            text[] not null default '{email}'
                        check (cardinality(channels) between 1 and 2 and channels <@ array['email','push']),
  also_notify_partner boolean not null default false,
  foreign key (item_id, household_id) references recurring_items(id, household_id) on delete cascade
);
create unique index reminder_rules_item_uq on reminder_rules(household_id, item_id) where item_id is not null;
create unique index reminder_rules_default_uq on reminder_rules(household_id) where item_id is null;

-- ===== notification_preferences (per user) =====
create table notification_preferences (
  user_id                 uuid primary key references users(id),
  email_enabled           boolean not null default true,
  -- Only non-essential kinds can be muted; proposal, security and system always reach the person.
  muted_kinds             text[] not null default '{}'
                            check (muted_kinds <@ array['reminder','review','task','digest']),
  email_suppressed_at     timestamptz,
  email_suppressed_reason text check (email_suppressed_reason in ('hard_bounce','complaint')),
  updated_at              timestamptz not null default now(),
  check ((email_suppressed_at is null) = (email_suppressed_reason is null))
);
create trigger notification_preferences_touch before update on notification_preferences
  for each row execute function app_touch_updated_at();

-- ===== notifications =====
create table notifications (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  user_id      uuid not null,
  kind         text not null check (kind in ('reminder','review','proposal','task','digest','security','system')),
  dedupe_key   text not null check (char_length(dedupe_key) between 1 and 200),
  title        text not null check (char_length(title) between 1 and 200),
  body         text not null check (char_length(body) <= 1000),
  -- App-relative only: a stored link can never point off our domain.
  deep_link    text check (deep_link is null or (char_length(deep_link) <= 300 and deep_link ~ '^/([A-Za-z0-9_?=&.%-][A-Za-z0-9/_?=&.%-]*)?$')),
  send_at      timestamptz not null,
  -- When the dispatcher next tries this row; null = send_at. A claim leases the row for 5 minutes and a failed
  -- send sets the retry time here, so send_at stays "when it was due" for the in-app list.
  attempt_at   timestamptz,
  status       text not null default 'scheduled' check (status in ('scheduled','sent','failed','cancelled')),
  read_at      timestamptz,
  -- Reminders only: which bill, which rule date (stable when the due date is moved), which offset, and the due
  -- date the row was planned for (the dispatcher compares it with the live occurrence before sending).
  item_id      uuid,
  scheduled_on date,
  offset_days  int check (offset_days between 0 and 60),
  due_on       date,
  created_at   timestamptz not null default now(),
  unique (id, household_id),
  unique (household_id, dedupe_key),
  check ((kind = 'reminder') = (item_id is not null)),
  check (item_id is null or (scheduled_on is not null and offset_days is not null and due_on is not null)),
  foreign key (household_id, user_id) references household_members(household_id, user_id),
  foreign key (item_id, household_id) references recurring_items(id, household_id) on delete cascade
);
create index notifications_due_idx on notifications((coalesce(attempt_at, send_at))) where status = 'scheduled';
create index notifications_user_idx on notifications(household_id, user_id, send_at desc, id);
create index notifications_item_idx on notifications(household_id, item_id) where status = 'scheduled';

-- ===== notification_deliveries =====
create table notification_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references households(id) on delete cascade,
  notification_id     uuid not null,
  channel             text not null check (channel in ('email','push')),
  provider_message_id text check (char_length(provider_message_id) <= 200),
  status              text not null check (status in ('queued','sent','delivered','bounced','complained','failed')),
  attempts            int not null default 0,
  -- A short code ("ses:Throttling", "smtp:ECONNREFUSED"); never a provider message, which can quote an address.
  last_error          text check (char_length(last_error) <= 100),
  updated_at          timestamptz not null default now(),
  unique (notification_id, channel),
  foreign key (notification_id, household_id) references notifications(id, household_id) on delete cascade
);
create unique index notification_deliveries_provider_uq on notification_deliveries(provider_message_id)
  where provider_message_id is not null;
create trigger notification_deliveries_touch before update on notification_deliveries
  for each row execute function app_touch_updated_at();

-- ===== send_quota_events (per user, not per household) =====
create table send_quota_events (
  id         bigserial primary key,
  user_id    uuid not null references users(id),
  kind       text not null check (kind in ('invite')),
  created_at timestamptz not null default now()
);
create index send_quota_events_idx on send_quota_events(user_id, kind, created_at);

-- ===== Row-level security =====
do $$
declare
  t text;
begin
  foreach t in array array['reminder_rules','notification_preferences','notifications','notification_deliveries','send_quota_events']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end
$$;

-- reminder_rules
create policy reminder_rules_api_select on reminder_rules for select to mp_api
  using (app_is_household_member(household_id));
create policy reminder_rules_api_insert on reminder_rules for insert to mp_api
  with check (app_is_household_member(household_id));
create policy reminder_rules_api_update on reminder_rules for update to mp_api
  using (app_is_household_member(household_id)) with check (app_is_household_member(household_id));
create policy reminder_rules_api_delete on reminder_rules for delete to mp_api
  using (app_is_household_member(household_id));
create policy reminder_rules_worker_job_scope on reminder_rules for all to mp_worker
  using (household_id = app_household_id()) with check (household_id = app_household_id());
grant select on reminder_rules to mp_api, mp_worker;
grant insert (id, household_id, item_id, offsets_days, channels, also_notify_partner) on reminder_rules to mp_api;
grant update (offsets_days, channels, also_notify_partner) on reminder_rules to mp_api;
grant delete on reminder_rules to mp_api;

-- notification_preferences: the user's own row; a job sees the members of its household (to decide channels).
create policy notification_preferences_api_select on notification_preferences for select to mp_api
  using (user_id = app_user_id());
create policy notification_preferences_api_insert on notification_preferences for insert to mp_api
  with check (user_id = app_user_id() and email_suppressed_at is null);
create policy notification_preferences_api_update on notification_preferences for update to mp_api
  using (user_id = app_user_id()) with check (user_id = app_user_id());
create policy notification_preferences_worker_select on notification_preferences for select to mp_worker
  using (exists (select 1 from household_members m
                  where m.user_id = notification_preferences.user_id and m.household_id = app_household_id()));
create policy notification_preferences_definer on notification_preferences for all to mp_migrator
  using (true) with check (true);
grant select on notification_preferences to mp_api, mp_worker;
grant insert (user_id, email_enabled, muted_kinds) on notification_preferences to mp_api;
grant update (email_enabled, muted_kinds) on notification_preferences to mp_api;

-- notifications
create policy notifications_api_select on notifications for select to mp_api
  using (app_is_household_member(household_id) and user_id = app_user_id());
create policy notifications_api_insert on notifications for insert to mp_api
  with check (app_is_household_member(household_id)
              and kind in ('proposal','task','review','system')
              and status = 'scheduled' and item_id is null);
create policy notifications_api_update on notifications for update to mp_api
  using (app_is_household_member(household_id) and user_id = app_user_id())
  with check (app_is_household_member(household_id) and user_id = app_user_id());
create policy notifications_worker_job_scope on notifications for all to mp_worker
  using (household_id = app_household_id()) with check (household_id = app_household_id());
create policy notifications_definer on notifications for all to mp_migrator
  using (true) with check (true);
grant select on notifications to mp_api, mp_worker;
grant insert (id, household_id, user_id, kind, dedupe_key, title, body, deep_link, send_at) on notifications to mp_api;
grant update (read_at) on notifications to mp_api;
grant insert (id, household_id, user_id, kind, dedupe_key, title, body, deep_link, send_at, status, item_id,
              scheduled_on, offset_days, due_on) on notifications to mp_worker;
grant update (title, body, deep_link, send_at, attempt_at, status, due_on) on notifications to mp_worker;

-- notification_deliveries: a member reads the deliveries of their own notifications (the subquery is itself
-- filtered by the notifications policy above); only jobs write.
create policy notification_deliveries_api_select on notification_deliveries for select to mp_api
  using (app_is_household_member(household_id)
         and exists (select 1 from notifications n
                      where n.id = notification_deliveries.notification_id and n.household_id = notification_deliveries.household_id));
create policy notification_deliveries_worker_job_scope on notification_deliveries for all to mp_worker
  using (household_id = app_household_id()) with check (household_id = app_household_id());
create policy notification_deliveries_definer on notification_deliveries for all to mp_migrator
  using (true) with check (true);
grant select on notification_deliveries to mp_api, mp_worker;
grant insert (id, household_id, notification_id, channel, provider_message_id, status, attempts, last_error)
  on notification_deliveries to mp_worker;
grant update (provider_message_id, status, attempts, last_error) on notification_deliveries to mp_worker;

-- send_quota_events: the signed-in user's own rows; old rows can be pruned by their owner.
create policy send_quota_events_api_select on send_quota_events for select to mp_api
  using (user_id = app_user_id());
create policy send_quota_events_api_insert on send_quota_events for insert to mp_api
  with check (user_id = app_user_id());
create policy send_quota_events_api_delete on send_quota_events for delete to mp_api
  using (user_id = app_user_id() and created_at < now() - interval '2 days');
grant select, delete on send_quota_events to mp_api;
grant insert (user_id, kind) on send_quota_events to mp_api;
grant usage on sequence send_quota_events_id_seq to mp_api;

-- ===== Households with something to send (the every-minute dispatch fan-out) =====
-- mp_worker is scoped to one household per job and cannot ask "which ones have due mail". Ids only.
create function app_list_households_with_due_notifications() returns setof uuid
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$ select distinct n.household_id from public.notifications n
         where n.status = 'scheduled' and coalesce(n.attempt_at, n.send_at) <= now() $$;
revoke all on function app_list_households_with_due_notifications() from public;
grant execute on function app_list_households_with_due_notifications() to mp_worker;

-- ===== SES delivery events (BACKEND_PLAN §7.6) =====
-- The webhook is not a household request: no user, no job. This function applies one verified SES event to the
-- delivery it names (found by the provider message id, which SES returns and nobody else can guess):
--   delivery   → delivered
--   bounce     → bounced; a Permanent bounce also turns the user's email channel off and leaves an in-app
--                `security` notification saying so
--   complaint  → complained; the email channel is turned off the same way
-- A status never moves backwards (a late "delivery" does not undo a bounce). Returns what happened:
-- 'applied', 'unknown' (no such delivery) or 'ignored' (an event type we do not track, or an old status).
create function app_record_delivery_event(p_provider_message_id text, p_event text, p_bounce_type text)
  returns text
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $$
declare
  v_delivery public.notification_deliveries%rowtype;
  v_user     uuid;
  v_reason   text;
  v_new      text;
begin
  if p_provider_message_id is null or char_length(p_provider_message_id) > 200 then
    return 'unknown';
  end if;
  select d.* into v_delivery from public.notification_deliveries d
   where d.provider_message_id = p_provider_message_id and d.channel = 'email' for update;
  if not found then
    return 'unknown';
  end if;
  select n.user_id into v_user from public.notifications n
   where n.id = v_delivery.notification_id and n.household_id = v_delivery.household_id;

  v_new := case p_event
             when 'delivery' then 'delivered'
             when 'bounce' then 'bounced'
             when 'complaint' then 'complained'
             else null end;
  if v_new is null then
    return 'ignored';
  end if;
  -- ranks: queued/sent 1, delivered 2, bounced 3, complained 4 (failed stays failed)
  if v_delivery.status = 'failed'
     or (case v_new when 'delivered' then 2 when 'bounced' then 3 else 4 end)
        <= (case v_delivery.status when 'delivered' then 2 when 'bounced' then 3 when 'complained' then 4 else 1 end)
  then
    -- A repeat of a recorded event is a no-op, except that a permanent bounce still has to suppress below.
    if not (v_new = 'bounced' and p_bounce_type = 'Permanent' and v_delivery.status = 'bounced') then
      return 'ignored';
    end if;
  end if;

  update public.notification_deliveries
     set status = v_new,
         last_error = case v_new when 'bounced' then 'ses:bounce:' || coalesce(left(p_bounce_type, 20), 'Unknown')
                                 when 'complained' then 'ses:complaint' else null end
   where id = v_delivery.id and status is distinct from v_new;

  v_reason := case when v_new = 'complained' then 'complaint'
                   when v_new = 'bounced' and p_bounce_type = 'Permanent' then 'hard_bounce'
                   else null end;
  if v_reason is not null and v_user is not null then
    insert into public.notification_preferences (user_id, email_suppressed_at, email_suppressed_reason)
    values (v_user, now(), v_reason)
    on conflict (user_id) do update
      set email_suppressed_at = coalesce(public.notification_preferences.email_suppressed_at, excluded.email_suppressed_at),
          email_suppressed_reason = coalesce(public.notification_preferences.email_suppressed_reason, excluded.email_suppressed_reason);
    insert into public.notifications (household_id, user_id, kind, dedupe_key, title, body, deep_link, send_at, status)
    values (v_delivery.household_id, v_user, 'security', 'email_suppressed:' || v_user::text || ':' || v_reason,
            case v_reason when 'complaint' then 'We turned off email notifications'
                          else 'We could not deliver email to you' end,
            case v_reason when 'complaint' then 'Your email provider reported our message as unwanted, so we stopped sending email. You still see everything here. Update your email address in Settings to start again.'
                          else 'Your email provider rejected a message permanently, so we stopped sending email. You still see everything here. Update your email address in Settings to start again.' end,
            '/privacy', now(), 'sent')
    on conflict (household_id, dedupe_key) do nothing;
  end if;
  return 'applied';
end
$$;
revoke all on function app_record_delivery_event(text, text, text) from public;
grant execute on function app_record_delivery_event(text, text, text) to mp_api;
