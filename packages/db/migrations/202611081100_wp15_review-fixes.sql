-- WP-15 security review fixes.
--   * notification_preferences.user_id and send_quota_events.user_id cascade on user deletion, so the account
--     deletion path (BACKEND_PLAN §6) is not blocked by these rows. Drop and re-add is expand-safe: the new
--     constraint only widens what a delete may do.
--   * notifications.claim_attempts counts how often the dispatcher claimed a row. A row that was claimed five
--     times without finishing (a crash or a thrown error each time) is marked failed instead of looping forever.
alter table notification_preferences drop constraint notification_preferences_user_id_fkey;
alter table notification_preferences add constraint notification_preferences_user_id_fkey
  foreign key (user_id) references users(id) on delete cascade;

alter table send_quota_events drop constraint send_quota_events_user_id_fkey;
alter table send_quota_events add constraint send_quota_events_user_id_fkey
  foreign key (user_id) references users(id) on delete cascade;

alter table notifications add column claim_attempts int not null default 0;
grant update (claim_attempts) on notifications to mp_worker;
