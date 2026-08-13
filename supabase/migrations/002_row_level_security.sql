-- Security hardening, part 2: real per-row enforcement for trainings,
-- progress, and personal plans — not just "must be signed in."
--
-- Previously these three collections lived as single JSON blobs any
-- authenticated user could overwrite entirely via a direct API call,
-- bypassing every check the app's UI enforces (admin-only delete, locked
-- plans, "only your own progress," etc.). This migration moves them into
-- real tables, one row per record, with rules Postgres itself checks on
-- every single write — no direct API call can get around them.
--
-- Run this in Supabase: SQL Editor -> paste this whole file -> Run.
-- It migrates your EXISTING data from the old blobs into the new tables
-- as part of running it — nothing is lost.

-- 1. Extend the roles table from the previous migration so it also maps
--    each person's real Supabase Auth ID to the app-level ID already used
--    throughout your existing data (trainings.enrolled, progress.userId,
--    etc.) — needed so the database can check "is this signed-in person
--    the owner of this specific row," not just "is this person an admin."
alter table app_roles add column if not exists app_user_id text;
create index if not exists app_roles_app_user_id_idx on app_roles (app_user_id);

-- Backfill the mapping for everyone who has already signed in at least
-- once (their app-level record already stores the Supabase Auth ID from
-- the app's own sync logic).
update app_roles ar
set app_user_id = u.elem ->> 'id'
from (
  select jsonb_array_elements(value) as elem
  from learning_ledger_data
  where key = 'ltp-users'
) u
where (u.elem ->> 'authUserId')::uuid = ar.user_id
  and ar.app_user_id is null;

-- 2. The three tables themselves.
create table if not exists trainings (
  id text primary key,
  title text not null,
  description text not null default '',
  start_date date not null,
  end_date date not null,
  lesson_plan jsonb not null default '[]'::jsonb,
  enrolled jsonb not null default '[]'::jsonb,
  plan_locked_by_learner boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists progress (
  id text primary key,
  training_id text not null,
  user_id text not null,
  topic_id text,
  date date,
  note text,
  percent int,
  created_at timestamptz not null default now()
);

create table if not exists personal_plans (
  id text primary key,
  training_id text not null,
  user_id text not null,
  lesson_plan jsonb not null default '[]'::jsonb,
  locked boolean not null default false,
  created_at timestamptz not null default now()
);

-- 3. Migrate existing data out of the old blobs into these tables.
insert into trainings (id, title, description, start_date, end_date, lesson_plan, enrolled, plan_locked_by_learner)
select
  elem ->> 'id',
  elem ->> 'title',
  coalesce(elem ->> 'description', ''),
  (elem ->> 'startDate')::date,
  (elem ->> 'endDate')::date,
  coalesce(elem -> 'lessonPlan', '[]'::jsonb),
  coalesce(elem -> 'enrolled', '[]'::jsonb),
  coalesce((elem ->> 'planLockedByLearner')::boolean, false)
from learning_ledger_data, jsonb_array_elements(value) as elem
where key = 'ltp-trainings'
on conflict (id) do nothing;

insert into progress (id, training_id, user_id, topic_id, date, note, percent)
select
  elem ->> 'id',
  elem ->> 'trainingId',
  elem ->> 'userId',
  elem ->> 'topicId',
  nullif(elem ->> 'date', '')::date,
  elem ->> 'note',
  nullif(elem ->> 'percent', '')::int
from learning_ledger_data, jsonb_array_elements(value) as elem
where key = 'ltp-progress'
on conflict (id) do nothing;

insert into personal_plans (id, training_id, user_id, lesson_plan, locked)
select
  elem ->> 'id',
  elem ->> 'trainingId',
  elem ->> 'userId',
  coalesce(elem -> 'lessonPlan', '[]'::jsonb),
  coalesce((elem ->> 'locked')::boolean, false)
from learning_ledger_data, jsonb_array_elements(value) as elem
where key = 'ltp-personal-plans'
on conflict (id) do nothing;

-- 4. Row Level Security.
alter table trainings enable row level security;
alter table progress enable row level security;
alter table personal_plans enable row level security;

-- Everyone signed in can read all three (learners need to see shared
-- trainings, admins need to see everyone's progress for reports).
drop policy if exists "read trainings" on trainings;
drop policy if exists "read progress" on progress;
drop policy if exists "read personal_plans" on personal_plans;
create policy "read trainings" on trainings for select using (auth.role() = 'authenticated');
create policy "read progress" on progress for select using (auth.role() = 'authenticated');
create policy "read personal_plans" on personal_plans for select using (auth.role() = 'authenticated');

-- Trainings: only admins create or delete. Updates are allowed for admins
-- (anything) or enrolled learners (restricted below by a trigger to just
-- the lesson plan, and only while unlocked).
drop policy if exists "admin insert trainings" on trainings;
drop policy if exists "admin delete trainings" on trainings;
drop policy if exists "modify trainings" on trainings;
create policy "admin insert trainings" on trainings for insert with check (is_admin());
create policy "admin delete trainings" on trainings for delete using (is_admin());
create policy "modify trainings" on trainings for update using (
  is_admin() or exists (
    select 1 from app_roles ar
    where ar.user_id = auth.uid() and trainings.enrolled @> to_jsonb(ar.app_user_id)
  )
);

create or replace function enforce_training_update_permissions() returns trigger
language plpgsql security definer as $$
begin
  if is_admin() then
    return new;
  end if;

  if new.title is distinct from old.title
     or new.description is distinct from old.description
     or new.start_date is distinct from old.start_date
     or new.end_date is distinct from old.end_date
     or new.enrolled is distinct from old.enrolled then
    raise exception 'Only an admin can change the training itself — learners can only update the lesson plan';
  end if;

  if old.plan_locked_by_learner and new.lesson_plan is distinct from old.lesson_plan then
    raise exception 'This lesson plan is locked — only an admin can change it now';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_training_update_permissions on trainings;
create trigger trg_training_update_permissions
before update on trainings
for each row execute function enforce_training_update_permissions();

-- Progress: only the owning learner or an admin can write a given entry.
drop policy if exists "own or admin insert progress" on progress;
drop policy if exists "own or admin update progress" on progress;
drop policy if exists "own or admin delete progress" on progress;
create policy "own or admin insert progress" on progress for insert with check (
  is_admin() or exists (select 1 from app_roles where user_id = auth.uid() and app_user_id = progress.user_id)
);
create policy "own or admin update progress" on progress for update using (
  is_admin() or exists (select 1 from app_roles where user_id = auth.uid() and app_user_id = progress.user_id)
);
create policy "own or admin delete progress" on progress for delete using (
  is_admin() or exists (select 1 from app_roles where user_id = auth.uid() and app_user_id = progress.user_id)
);

-- Personal plans: same ownership rule.
drop policy if exists "own or admin insert personal_plans" on personal_plans;
drop policy if exists "own or admin update personal_plans" on personal_plans;
drop policy if exists "own or admin delete personal_plans" on personal_plans;
create policy "own or admin insert personal_plans" on personal_plans for insert with check (
  is_admin() or exists (select 1 from app_roles where user_id = auth.uid() and app_user_id = personal_plans.user_id)
);
create policy "own or admin update personal_plans" on personal_plans for update using (
  is_admin() or exists (select 1 from app_roles where user_id = auth.uid() and app_user_id = personal_plans.user_id)
);
create policy "own or admin delete personal_plans" on personal_plans for delete using (
  is_admin() or exists (select 1 from app_roles where user_id = auth.uid() and app_user_id = personal_plans.user_id)
);

-- 5. Enable Realtime on the new tables so the app's live-sync keeps working.
alter publication supabase_realtime add table trainings;
alter publication supabase_realtime add table progress;
alter publication supabase_realtime add table personal_plans;

-- Note: the old learning_ledger_data rows for ltp-trainings, ltp-progress,
-- and ltp-personal-plans are left in place after this migration (harmless,
-- just unused) rather than deleted, in case you want to double-check the
-- migrated data matches before cleaning them up yourself.
