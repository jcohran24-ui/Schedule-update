-- One-time reset: clear all live/current activity dates.
-- Baseline/original schedule dates are NOT changed.

begin;

update public.activities
set
  current_start = null,
  current_finish = null;

commit;

-- Verification: should return 0 rows after the reset.
select id, activity_code, activity_name, current_start, current_finish
from public.activities
where current_start is not null
   or current_finish is not null
order by activity_code;
