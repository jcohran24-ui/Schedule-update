-- V42 Project backup snapshots
-- Run once in Supabase > SQL Editor before using Admin > Backups.

create table if not exists public.project_backups (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  backup_name text not null,
  backup_type text not null default 'manual',
  source_filename text,
  activity_count integer not null default 0,
  history_count integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_project_backups_project_created
on public.project_backups(project_id, created_at desc);

alter table public.project_backups enable row level security;

drop policy if exists "activity admin sees backups" on public.project_backups;
create policy "activity admin sees backups" on public.project_backups
for select to authenticated using (public.is_activity_admin());

drop policy if exists "activity admin inserts backups" on public.project_backups;
create policy "activity admin inserts backups" on public.project_backups
for insert to authenticated with check (public.is_activity_admin());

drop policy if exists "activity admin deletes backups" on public.project_backups;
create policy "activity admin deletes backups" on public.project_backups
for delete to authenticated using (public.is_activity_admin());

grant select, insert, delete on public.project_backups to authenticated;
