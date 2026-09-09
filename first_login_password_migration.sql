-- First-login password change support
-- Run once in Supabase > SQL Editor before deploying this app version.

alter table public.profiles
add column if not exists must_change_password boolean not null default false;

-- Existing users stay unchanged (false). New users created by the app are set to true.
-- No client-side UPDATE policy is needed: after the user successfully changes their
-- Supabase Auth password, the server verifies their access token and clears this flag
-- using the service-role key.
