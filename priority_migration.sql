-- V54 - HOT / WATCH activity priority
-- Run once in Supabase > SQL Editor before using the priority controls.

alter table public.activities
  add column if not exists priority text not null default 'Normal'
    check (priority in ('Normal','Watch','HOT')),
  add column if not exists priority_reason text;

-- Priority is a superintendent / Activity Admin setup field. Subs can see it,
-- but cannot change it while updating their own progress information.
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
       or old.created_at is distinct from new.created_at
       or old.priority is distinct from new.priority
       or old.priority_reason is distinct from new.priority_reason then
      raise exception 'Only the Activity Admin can edit activity setup fields';
    end if;
  end if;
  return new;
end;
$$;
