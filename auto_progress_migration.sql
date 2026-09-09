-- Adds automatic percent-complete mode for schedule activities.
alter table public.activities
  add column if not exists auto_percent boolean not null default true;

-- Existing activities will use automatic progress unless an admin turns it off.
update public.activities set auto_percent = true where auto_percent is null;
