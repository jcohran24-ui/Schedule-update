-- Trade Schedule V1 - Supabase schema
-- Run this entire file once in Supabase > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  company_name text not null unique,
  trade text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  project_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null check (role in ('gc_admin','gc','sub')),
  company_id uuid references public.companies(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  activity_code text not null,
  activity_name text not null,
  area text,
  original_start date,
  original_finish date,
  current_start date,
  current_finish date,
  duration_days integer,
  status text not null default 'Not Started' check (status in ('Not Started','Starting Soon','In Progress','Complete','Delayed','On Hold')),
  percent_complete integer not null default 0 check (percent_complete between 0 and 100),
  notes text,
  source_upload text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(project_id, activity_code)
);

create table if not exists public.activity_history (
  id bigint generated always as identity primary key,
  activity_id uuid not null references public.activities(id) on delete cascade,
  changed_by uuid references auth.users(id) on delete set null,
  old_start date,
  new_start date,
  old_finish date,
  new_finish date,
  old_status text,
  new_status text,
  old_percent integer,
  new_percent integer,
  comment text,
  changed_at timestamptz not null default now()
);

create table if not exists public.schedule_uploads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  filename text not null,
  rows_imported integer not null default 0,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now()
);

create or replace function public.is_gc()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active = true and p.role in ('gc','gc_admin')
  );
$$;

create or replace function public.is_gc_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active = true and p.role = 'gc_admin'
  );
$$;

create or replace function public.my_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id from public.profiles where id = auth.uid() and active = true;
$$;

create or replace function public.log_activity_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  if (old.current_start is distinct from new.current_start)
     or (old.current_finish is distinct from new.current_finish)
     or (old.status is distinct from new.status)
     or (old.percent_complete is distinct from new.percent_complete)
     or (old.notes is distinct from new.notes) then
    insert into public.activity_history(
      activity_id, changed_by, old_start, new_start, old_finish, new_finish,
      old_status, new_status, old_percent, new_percent, comment
    ) values (
      new.id, auth.uid(), old.current_start, new.current_start, old.current_finish, new.current_finish,
      old.status, new.status, old.percent_complete, new.percent_complete, new.notes
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_activity_update on public.activities;
create trigger trg_activity_update
before update on public.activities
for each row execute function public.log_activity_update();

alter table public.companies enable row level security;
alter table public.projects enable row level security;
alter table public.profiles enable row level security;
alter table public.activities enable row level security;
alter table public.activity_history enable row level security;
alter table public.schedule_uploads enable row level security;

-- Companies
create policy "authenticated can view companies" on public.companies
for select to authenticated using (true);
create policy "gc admin can insert companies" on public.companies
for insert to authenticated with check (public.is_gc_admin());
create policy "gc admin can update companies" on public.companies
for update to authenticated using (public.is_gc_admin()) with check (public.is_gc_admin());

-- Projects
create policy "authenticated can view projects" on public.projects
for select to authenticated using (active = true or public.is_gc());
create policy "gc admin can insert projects" on public.projects
for insert to authenticated with check (public.is_gc_admin());
create policy "gc admin can update projects" on public.projects
for update to authenticated using (public.is_gc_admin()) with check (public.is_gc_admin());

-- Profiles: users can see themselves; GC can see all
create policy "profile visibility" on public.profiles
for select to authenticated using (id = auth.uid() or public.is_gc());

-- Activities
create policy "gc sees all activities" on public.activities
for select to authenticated using (public.is_gc());
create policy "sub sees own company activities" on public.activities
for select to authenticated using (company_id = public.my_company_id());
create policy "gc admin imports activities" on public.activities
for insert to authenticated with check (public.is_gc_admin());
create policy "gc updates all activities" on public.activities
for update to authenticated using (public.is_gc()) with check (public.is_gc());
create policy "sub updates own activities" on public.activities
for update to authenticated using (company_id = public.my_company_id()) with check (company_id = public.my_company_id());

-- History
create policy "gc sees all history" on public.activity_history
for select to authenticated using (public.is_gc());
create policy "sub sees own activity history" on public.activity_history
for select to authenticated using (
  exists(select 1 from public.activities a where a.id = activity_id and a.company_id = public.my_company_id())
);

-- Upload log
create policy "gc sees uploads" on public.schedule_uploads
for select to authenticated using (public.is_gc());
create policy "gc admin inserts uploads" on public.schedule_uploads
for insert to authenticated with check (public.is_gc_admin());

-- Prevent subcontractors from changing activity ownership/baseline/name via the API.
revoke update on public.activities from authenticated;
grant update (current_start, current_finish, status, percent_complete, notes) on public.activities to authenticated;
grant select on public.activities to authenticated;
grant insert on public.activities to authenticated;
grant select on public.companies, public.projects, public.profiles, public.activity_history, public.schedule_uploads to authenticated;
grant insert, update on public.companies, public.projects to authenticated;
grant insert on public.schedule_uploads to authenticated;

grant usage, select on sequence public.activity_history_id_seq to authenticated;

-- After creating your first Auth user in Supabase, make that person GC Admin with:
-- insert into public.profiles(id,email,full_name,role)
-- values ('AUTH_USER_UUID','you@example.com','Your Name','gc_admin');
