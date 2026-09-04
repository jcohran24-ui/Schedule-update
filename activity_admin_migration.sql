-- Activity Admin migration for an EXISTING Trade Schedule database.
-- Run this in Supabase > SQL Editor after replacing YOUR_EMAIL@example.com below.

alter table public.profiles
add column if not exists is_activity_admin boolean not null default false;

create unique index if not exists one_activity_admin_only
on public.profiles ((is_activity_admin)) where is_activity_admin = true;

-- Make sure nobody else has the permission, then grant it only to your account.
update public.profiles set is_activity_admin = false;
update public.profiles
set is_activity_admin = true
where lower(email) = lower('YOUR_EMAIL@example.com');

create or replace function public.is_activity_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.active = true
      and p.is_activity_admin = true
  );
$$;

create or replace function public.protect_activity_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_activity_admin() then
    if old.id is distinct from new.id
       or old.project_id is distinct from new.project_id
       or old.company_id is distinct from new.company_id
       or old.activity_code is distinct from new.activity_code
       or old.activity_name is distinct from new.activity_name
       or old.area is distinct from new.area
       or old.original_start is distinct from new.original_start
       or old.original_finish is distinct from new.original_finish
       or old.duration_days is distinct from new.duration_days
       or old.source_upload is distinct from new.source_upload
       or old.created_at is distinct from new.created_at then
      raise exception 'Only the Activity Admin can edit activity setup fields';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_activity_fields on public.activities;
create trigger trg_protect_activity_fields
before update on public.activities
for each row execute function public.protect_activity_fields();

-- Replace activity write policies.
drop policy if exists "gc admin imports activities" on public.activities;
drop policy if exists "activity admin inserts activities" on public.activities;
drop policy if exists "gc updates all activities" on public.activities;
drop policy if exists "activity admin updates all activities" on public.activities;
drop policy if exists "activity admin deletes activities" on public.activities;

create policy "activity admin inserts activities" on public.activities
for insert to authenticated
with check (public.is_activity_admin());

create policy "activity admin updates all activities" on public.activities
for update to authenticated
using (public.is_activity_admin())
with check (public.is_activity_admin());

-- Keep the existing subcontractor policy so subs can update their own rows.
-- The trigger above limits them to progress/update fields.
create policy "activity admin deletes activities" on public.activities
for delete to authenticated
using (public.is_activity_admin());

-- Allow update/delete at the table privilege layer; RLS + trigger enforce security.
revoke update on public.activities from authenticated;
grant update on public.activities to authenticated;
grant select, insert, delete on public.activities to authenticated;

-- Verify the one Activity Admin account.
select id, email, full_name, role, is_activity_admin
from public.profiles
where is_activity_admin = true;

-- Schedule uploads are owned by the Activity Admin too.
drop policy if exists "gc admin inserts uploads" on public.schedule_uploads;
drop policy if exists "activity admin inserts uploads" on public.schedule_uploads;
create policy "activity admin inserts uploads" on public.schedule_uploads
for insert to authenticated
with check (public.is_activity_admin());
