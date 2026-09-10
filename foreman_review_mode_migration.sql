-- V20 Foreman Review Mode
alter table public.activities
  add column if not exists scope_issue boolean not null default false,
  add column if not exists last_reviewed_at timestamptz;

-- Existing RLS already limits subcontractors to their own company rows.
-- These fields are intentionally updateable by subcontractors as part of review mode.
