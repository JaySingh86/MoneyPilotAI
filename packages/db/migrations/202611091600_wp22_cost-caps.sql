-- WP-22 review fixes · cost caps and idempotent metering (security review B1, N4). Expand-only.
--
--   email_messages.extract_charged_at / extract_new_sender
--                   set just before a message is sent to the model (or reserved for a batch): when it was charged
--                   against the household's daily extraction budget, and whether its sender was new to the household
--                   (the smaller sub-cap for never-seen senders counts these). No content, only a time and a flag.
--   ai_runs.reference
--                   the message id a call was for. A batch result is recorded once per message: a retried collect
--                   cannot double-meter it (unique index below, batch rows only; a second DIRECT call for the same
--                   message is a real second call and is recorded).

alter table email_messages
  add column extract_charged_at timestamptz,
  add column extract_new_sender boolean not null default false;
create index email_messages_charged_idx on email_messages(household_id, extract_charged_at)
  where extract_charged_at is not null;

alter table ai_runs add column reference text check (reference is null or char_length(reference) <= 100);
create unique index ai_runs_batch_reference_uq on ai_runs(household_id, reference)
  where batch and reference is not null;

grant update (extract_charged_at, extract_new_sender) on email_messages to mp_worker;
