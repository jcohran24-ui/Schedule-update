# Trade Schedule V1

A deployable GC/subcontractor remaining-schedule web app.

## Included
- Supabase email/password login
- Roles: `gc_admin`, `gc`, `sub`
- Database-level Row Level Security
- Subcontractors can only see/update activities assigned to their company
- GC users can see the full live schedule
- Baseline dates remain separate from current dates
- 4-week and 6-week look-ahead filters
- Trade/status/search filters
- Status + percent-complete updates
- Automatic activity change history
- Project/company management
- GC Admin user creation/deactivation
- Excel/CSV schedule import
- Render deployment configuration

## 1. Create the Supabase database
1. Create a Supabase project.
2. Open **SQL Editor**.
3. Paste and run `supabase_schema.sql`.
4. In **Authentication > Users**, create your first user manually.
5. Copy that user's UUID.
6. In SQL Editor, run:

```sql
insert into public.profiles(id,email,full_name,role)
values ('YOUR_AUTH_USER_UUID','YOUR_EMAIL','YOUR_NAME','gc_admin');
```

## 2. Get Supabase keys
In Supabase **Project Settings > API**, copy:
- Project URL
- anon/public key
- service_role key

Keep the service_role key private. It is only used server-side for GC Admin user management.

## 3. Deploy to Render
Create a new Web Service from this repository/project.

Build command:
```
pip install -r requirements.txt
```

Start command:
```
gunicorn app:app
```

Add these environment variables:
```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

## 4. First setup in the app
1. Sign in as the GC Admin account.
2. Open **Admin**.
3. Add the project.
4. Add subcontractor companies/trades (or let the import create them from the Trade/Company column).
5. Create foreman users and assign each `sub` user to the proper company.
6. Upload the remaining schedule Excel/CSV.

## Recommended import columns
The importer recognizes several common aliases. Best format:

| Activity ID | Activity Name | Start | Finish | Duration | Trade/Company | Area |
|---|---|---|---|---:|---|---|
| C9080 | A2 Pour Back | 9/8/2026 | 9/10/2026 | 3 | Precision Concrete | A2 |

Other recognized headings include `Activity Code`, `Description`, `Company`, `Subcontractor`, `Trade`, `Location`, `Start Date`, and `Finish Date`.

## Important import behavior
The initial imported Start/Finish become both:
- `original_start` / `original_finish` (baseline, preserved)
- `current_start` / `current_finish` (foreman-editable current dates)

Existing Activity IDs are not overwritten by later imports in V1. This protects foreman updates. A later version can add a controlled schedule-revision reconciliation screen.

## V1 security model
Subcontractors can update only these columns on activities assigned to their company:
- Current Start
- Current Finish
- Status
- Percent Complete
- Notes

They cannot change company assignment, baseline dates, Activity ID, or Activity Name through the database API.

## Activity Admin upgrade

This version adds a separate `is_activity_admin` permission. It is intended to be `true` for only one user (the schedule owner).

For an existing deployment:
1. Open `activity_admin_migration.sql`.
2. Replace `YOUR_EMAIL@example.com` with your login email.
3. Run the full migration in Supabase SQL Editor.
4. Redeploy this app version to Render.

Permissions after the migration:
- Activity Admin: can add, edit, reassign, and delete activities; can also update progress fields.
- Other GC / GC Admin users: view-only for schedule activities (GC Admin can still manage projects, companies, and users).
- Subcontractors: can update only their own company's current dates, status, percent complete, and notes.

The Admin page includes an **Activity Management** table visible only to the Activity Admin account.


## Admin password management
GC Admin users can set a replacement password for any user from Admin > User Management. Existing passwords are never displayed or retrievable. Password changes are performed server-side with the Supabase service role key.


## First-login password change

Run `first_login_password_migration.sql` once in Supabase before deploying this version. New users created from Admin are marked `must_change_password = true`. Their first successful login is restricted to the Change Password screen. After they choose a new 8+ character password, the app clears the flag and opens the schedule. Existing users are not forced to change passwords.


## Admin user deletion
GC Admin users can permanently delete managed users from Admin > User Management. The signed-in admin cannot delete their own account, and the Activity Admin account is protected from deletion. Deleting an Auth user also removes its public profile through the existing ON DELETE CASCADE relationship.


## Automatic percent complete
Run `auto_progress_migration.sql` once in Supabase SQL Editor before deploying this version. Activities marked **In Progress** automatically display percent complete from elapsed Monday-Friday workdays divided by the activity duration, capped at 99% until marked Complete. Activity Admin can turn Auto % off for an activity and enter a manual percentage.


## v13 - Two-way current date calculation
- Enter Current Start to calculate Current Finish from duration.
- Enter only Current Finish to calculate Current Start backwards from duration.
- Calculations skip Saturdays and Sundays and treat start/finish as inclusive workdays.
- If both dates are already entered, entering/changing Finish does not overwrite Start.
