-- WP-22 re-review fix · a message released from a batch more than once fails (expand-only).
-- `extract_releases` counts how often a message was given back to the waiting set because its result could not be used
-- (a refused or errored batch item whose direct re-run was over the daily cap). The second release fails the message, so
-- one stubborn message cannot cycle through batches forever.
alter table email_messages add column extract_releases smallint not null default 0 check (extract_releases >= 0);
grant update (extract_releases) on email_messages to mp_worker;
