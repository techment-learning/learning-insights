-- Security hardening: database-enforced admin checks
--
-- Previously, "who is admin" only lived inside a JSON blob that any
-- authenticated (or even anonymous, before an earlier fix) client could
-- write to directly via the API, bypassing the app's UI entirely. This
-- migration adds a real Postgres table tied to Supabase Auth's own user
-- IDs, and makes the database itself refuse role/user writes from anyone
-- it can't verify is an admin — not just anyone the app's UI trusts.
--
-- Run this in Supabase: SQL Editor -> paste this whole file -> Run.

-- 1. A dedicated table for role authorization, separate from the app's own
--    JSON data. This is intentionally minimal and only used for security
--    checks, not as the app's primary data store.
create table if not exists app_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'learner' check (role in ('admin', 'learner')),
  updated_at timestamptz not null default now()
);

alter table app_roles enable row level security;

-- 2. Helper functions the RLS policies below use.
create or replace function is_admin() returns boolean
language sql security definer stable as $$
  select exists (select 1 from app_roles where user_id = auth.uid() and role = 'admin');
$$;

create or replace function any_admin_exists() returns boolean
language sql security definer stable as $$
  select exists (select 1 from app_roles where role = 'admin');
$$;

-- 3. Who can read/write app_roles itself.
--    - Anyone signed in can read it (needed so is_admin() can be evaluated
--      as part of other policies, and so the app can check its own role).
--    - Inserting/updating your OWN row is allowed only as "learner", or as
--      "admin" if literally nobody is admin yet (first-ever person
--      bootstrapping the workspace). You can never self-promote once an
--      admin already exists — only an existing admin can do that, for you
--      or anyone else.
--    - Only admins can delete a role row.
drop policy if exists "Authenticated read roles" on app_roles;
drop policy if exists "Self bootstrap or admin insert" on app_roles;
drop policy if exists "Self bootstrap or admin update" on app_roles;
drop policy if exists "Admin delete roles" on app_roles;

create policy "Authenticated read roles" on app_roles
  for select using (auth.role() = 'authenticated');

create policy "Self bootstrap or admin insert" on app_roles
  for insert with check (
    is_admin() or (user_id = auth.uid() and (role = 'learner' or not any_admin_exists()))
  );

create policy "Self bootstrap or admin update" on app_roles
  for update using (is_admin() or user_id = auth.uid())
  with check (
    is_admin() or (user_id = auth.uid() and (role = 'learner' or not any_admin_exists()))
  );

create policy "Admin delete roles" on app_roles
  for delete using (is_admin());

-- 4. Lock down the app's actual data table. Reading stays open to any
--    signed-in user (learners need to see shared trainings etc.), but
--    writing to the "ltp-users" row — the one that controls names, emails,
--    and roles — now requires is_admin() to return true. Every other key
--    (trainings, progress, personal plans) still allows any authenticated
--    write, since learners legitimately need those for their own work.
drop policy if exists "Allow read" on learning_ledger_data;
drop policy if exists "Allow insert" on learning_ledger_data;
drop policy if exists "Allow update" on learning_ledger_data;
drop policy if exists "Authenticated read" on learning_ledger_data;
drop policy if exists "Authenticated insert" on learning_ledger_data;
drop policy if exists "Authenticated update" on learning_ledger_data;
drop policy if exists "Admin-only writes to user data" on learning_ledger_data;
drop policy if exists "Admin-only updates to user data" on learning_ledger_data;

create policy "Authenticated read" on learning_ledger_data
  for select using (auth.role() = 'authenticated');

create policy "Admin-only writes to user data" on learning_ledger_data
  for insert with check (
    auth.role() = 'authenticated' and (key <> 'ltp-users' or is_admin())
  );

create policy "Admin-only updates to user data" on learning_ledger_data
  for update using (
    auth.role() = 'authenticated' and (key <> 'ltp-users' or is_admin())
  );
