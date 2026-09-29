-- V56 - Automatic HOT suggestion review workflow
-- Run once in Supabase > SQL Editor after the V54 priority migration.

alter table public.activities
  add column if not exists hot_suggestion_reviewed_at timestamptz;

-- The review stamp belongs to the GC Activity Admin workflow. Subs can see the
-- result of a confirmed HOT priority but cannot clear or alter the admin review.
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
       or old.priority_reason is distinct from new.priority_reason
       or old.hot_suggestion_reviewed_at is distinct from new.hot_suggestion_reviewed_at then
      raise exception 'Only the Activity Admin can edit activity setup fields';
    end if;
  end if;
  return new;
end;
$$;
