-- The real fix (run this right after 003).
--
-- The blob-based "ltp-users" record could never correctly express both
-- rules at once: "anyone can register themselves" AND "nobody can grant
-- themselves admin, or touch anyone else's account." Row-level security
-- checks whole rows, and the blob was one giant row containing everyone.
--
-- This migration gives every person their own row in a real "profiles"
-- table, with rules Postgres enforces per-row:
--   - Anyone can insert their OWN new row (self sign-up) — but not as
--     admin, unless the workspace has no admin yet.
--   - Anyone can attach their signed-in identity to a pre-provisioned row
--     ONLY if the email matches their own — closes the loop where someone
--     could otherwise claim a different person's pending account.
--   - An admin can do anything, for anyone.
--   - A non-admin can never change a role, an email, or whose account a
--     row belongs to — enforced by a trigger, not just a policy.
--
-- Run this in Supabase: SQL Editor -> paste this whole file -> Run.
-- Existing user data is migrated in automatically.

create table if not exists profiles (
  id text primary key,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  name text not null,
  email text not null,
  role text not null default 'learner' check (role in ('admin', 'learner')),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- Migrate existing data out of the old blob.
insert into profiles (id, auth_user_id, name, email, role)
select
  elem ->> 'id',
  nullif(elem ->> 'authUserId', '')::uuid,
  elem ->> 'name',
  elem ->> 'email',
  coalesce(elem ->> 'role', 'learner')
from learning_ledger_data, jsonb_array_elements(value) as elem
where key = 'ltp-users'
on conflict (id) do nothing;

drop policy if exists "read profiles" on profiles;
drop policy if exists "insert profiles" on profiles;
drop policy if exists "update profiles" on profiles;
drop policy if exists "delete profiles" on profiles;

create policy "read profiles" on profiles for select using (auth.role() = 'authenticated');

create policy "insert profiles" on profiles for insert with check (
  is_admin() or (auth_user_id = auth.uid() and (role = 'learner' or not any_admin_exists()))
);

create policy "delete profiles" on profiles for delete using (is_admin());

create policy "update profiles" on profiles for update using (
  is_admin() or auth_user_id = auth.uid() or auth_user_id is null
);

create or replace function enforce_profile_update_permissions() returns trigger
language plpgsql security definer as $$
begin
  if is_admin() then
    return new;
  end if;

  -- Claiming a pre-provisioned row for the first time (attaching your
  -- signed-in identity to an account an admin already set up for you).
  if old.auth_user_id is null and new.auth_user_id = auth.uid() then
    if lower(new.email) <> lower(coalesce(auth.jwt() ->> 'email', '')) then
      raise exception 'Can only claim a profile matching your own signed-in email';
    end if;
    if new.role is distinct from old.role and not (new.role = 'learner' or (new.role = 'admin' and not any_admin_exists())) then
      raise exception 'Only an admin can grant admin access';
    end if;
    return new;
  end if;

  if new.auth_user_id is distinct from old.auth_user_id
     or new.role is distinct from old.role
     or new.email is distinct from old.email then
    raise exception 'Only an admin can change a role, email, or account link';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_profile_update_permissions on profiles;
create trigger trg_profile_update_permissions
before update on profiles
for each row execute function enforce_profile_update_permissions();

alter publication supabase_realtime add table profiles;

-- Now that profiles handles this properly, put the real protection back —
-- the temporary hotfix from migration 003 is no longer needed. This also
-- closes the "learning_ledger_data" blob to writes for the ltp-users key
-- entirely (the app no longer uses it once this migration is applied).
drop policy if exists "Authenticated writes to user data (temporary)" on learning_ledger_data;
drop policy if exists "Authenticated updates to user data (temporary)" on learning_ledger_data;

create policy "Admin-only writes to user data" on learning_ledger_data
  for insert with check (
    auth.role() = 'authenticated' and (key <> 'ltp-users' or is_admin())
  );

create policy "Admin-only updates to user data" on learning_ledger_data
  for update using (
    auth.role() = 'authenticated' and (key <> 'ltp-users' or is_admin())
  );
