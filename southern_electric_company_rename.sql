-- V60 - Rename Southeast Electrical to Southern Electric Company
-- Run once in Supabase SQL Editor after deploying V60.

begin;

-- Rename the existing company record in place so activity/company/profile IDs remain unchanged.
update public.companies
set company_name = 'Southern Electric Company'
where lower(trim(company_name)) in (
  'southeast electrical',
  'southeast electric'
);

commit;
