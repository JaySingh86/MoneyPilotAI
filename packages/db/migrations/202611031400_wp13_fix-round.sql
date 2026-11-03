-- WP-13 fix round (security review M1, M4, L1, L2). Tightens policies and constraints of the WP-13 tables.

-- ===== M1: a decision always names a decider who is not the proposer =====
alter table proposals add constraint proposals_decided_by_required_chk
  check (status not in ('approved','rejected','applied') or decided_by is not null);
-- superseded and expired are recorded by the service or the worker, never as someone's decision
alter table proposals add constraint proposals_system_status_chk
  check (status not in ('superseded','expired') or decided_by is null);

drop policy proposals_api_update on proposals;
create policy proposals_api_update on proposals for update to mp_api
  using (app_is_household_member(household_id) and status = 'pending')
  with check (
    app_is_household_member(household_id)
    and (
      (status = 'pending' and decided_by is null)
      or (status in ('approved','rejected','applied')
          and decided_by = app_user_id() and proposed_by <> app_user_id())
      or (status in ('superseded','expired') and decided_by is null)
    )
  );

-- ===== L1: only the kinds the service creates (plan_option is reserved) =====
drop policy proposals_api_insert on proposals;
create policy proposals_api_insert on proposals for insert to mp_api
  with check (app_is_household_member(household_id) and proposed_by = app_user_id() and status = 'pending'
              and kind in ('goal_change','item_change','shortfall_option'));

-- ===== M4: one pending proposal per (household, payload type, target) =====
-- Target = the occurrence, planned expense, goal or item the payload names, in that order.
create unique index proposals_one_pending_uq on proposals (
  household_id,
  (payload ->> 'type'),
  (coalesce(payload ->> 'occurrenceId', payload ->> 'plannedExpenseId', payload ->> 'goalId', payload ->> 'itemId', ''))
) where status = 'pending';

-- ===== L2: the API writes plain user tasks only, and completes them as itself =====
drop policy tasks_api_insert on tasks;
create policy tasks_api_insert on tasks for insert to mp_api
  with check (app_is_household_member(household_id) and created_by = app_user_id() and completed_at is null
              and source = 'user' and auto_complete_rule is null and dedupe_key is null);

-- A policy can't compare the new row with the old one, and editing a task that the other member completed
-- must keep their completed_by. So the rule "a completer is the signed-in member" is a trigger on change.
create function app_tasks_guard_completer() returns trigger
  language plpgsql
  as $$
begin
  if current_user = 'mp_api'
     and new.completed_by is distinct from old.completed_by
     and new.completed_by is not null
     and new.completed_by is distinct from app_user_id() then
    raise exception 'tasks: completed_by must be the signed-in member' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function app_tasks_guard_completer() from public;
create trigger tasks_guard_completer before update on tasks
  for each row execute function app_tasks_guard_completer();
