FOREMAN BULK USER CREATION

Creates the listed foremen as Subcontractor users in the Schedule Update app.

Temporary password for every user:
    password

Every created user is set:
    role = sub
    active = true
    must_change_password = true

The app will require them to choose a new password after their first successful login.

HOW TO RUN

Option 1 - Render Shell
1. Add both create_foreman_users.py and foreman_users.csv to your GitHub repository.
2. Deploy to Render.
3. Open your Render service -> Shell.
4. Run:

   python create_foreman_users.py foreman_users.csv

The script uses the SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY already configured
in your Render environment.

Option 2 - Local computer
Set these environment variables first:
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY

Then run:
    pip install requests
    python create_foreman_users.py foreman_users.csv

NOTES
- Existing users are skipped.
- It matches company names already in the app, including common aliases.
- If a company is missing from the Companies table, that user is not created.
- The Supabase service role key must remain private. Do not put it inside the CSV
  or commit the key to GitHub.
