-- Hotfix: unblock sign-ins immediately.
--
-- Migration 001 made the "ltp-users" record admin-only to write, which
-- correctly stops role tampering — but also accidentally blocks a brand
-- new learner from writing themselves into that same shared record the
-- very first time they sign in, since that's technically the same
-- protected write. That's what was blocking your team just now.
--
-- This migration reopens writes to any authenticated user (matching the
-- original, pre-lockdown behavior) so everyone can sign in again right
-- away. Migration 004 (run right after this one) replaces the blob
-- entirely with a real per-row table that closes the original role-
-- tampering hole WITHOUT blocking new sign-ups — the correct long-term
-- fix. Treat this one as temporary; don't stop here.

drop policy if exists "Admin-only writes to user data" on learning_ledger_data;
drop policy if exists "Admin-only updates to user data" on learning_ledger_data;

create policy "Authenticated writes to user data (temporary)" on learning_ledger_data
  for insert with check (auth.role() = 'authenticated');

create policy "Authenticated updates to user data (temporary)" on learning_ledger_data
  for update using (auth.role() = 'authenticated');
