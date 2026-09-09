#!/usr/bin/env python3
import os
import csv
import sys
import requests

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
CSV_FILE = sys.argv[1] if len(sys.argv) > 1 else "foreman_users.csv"

if not SUPABASE_URL or not SERVICE_KEY:
    raise SystemExit(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable."
    )

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

# Accept common project naming variations.
ALIASES = {
    "alamo": ["Alamo"],
    "shumate": ["Shumate"],
    "m&j plumbing": ["M&J Plumbing", "M&J", "M & J Plumbing"],
    "precision concrete": ["Precision Concrete", "Precision"],
    "midsouth steel": ["Midsouth Steel", "Mid-South Steel", "Mid South Steel"],
    "weller pools": ["Weller Pools", "Weller"],
    "southeast electrical": ["Southeast Electrical", "SEC", "SouthEast Electrical"],
    "b&m masonry": ["B&M Masonry", "B&M", "B & M Masonry"],
}

def get_companies():
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/companies",
        params={"select": "id,company_name"},
        headers=HEADERS,
        timeout=20,
    )
    r.raise_for_status()
    return r.json()

def find_company_id(companies, requested):
    by_name = {str(c["company_name"]).strip().lower(): c["id"] for c in companies}
    candidates = ALIASES.get(requested.strip().lower(), [requested])
    for name in candidates:
        cid = by_name.get(name.strip().lower())
        if cid:
            return cid
    return None

def existing_profile(email):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/profiles",
        params={"email": f"eq.{email.lower()}", "select": "id,email,full_name"},
        headers=HEADERS,
        timeout=20,
    )
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else None

companies = get_companies()

created = 0
skipped = 0
failed = 0

with open(CSV_FILE, newline="", encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        full_name = row["full_name"].strip()
        email = row["email"].strip().lower()
        company_name = row["company_name"].strip()
        role = (row.get("role") or "sub").strip()
        password = row.get("temporary_password") or "password"

        print(f"\n{full_name} <{email}> — {company_name}")

        if existing_profile(email):
            print("  SKIP: user/profile already exists")
            skipped += 1
            continue

        company_id = find_company_id(companies, company_name)
        if not company_id:
            print(f"  ERROR: company not found in app: {company_name}")
            failed += 1
            continue

        auth = requests.post(
            f"{SUPABASE_URL}/auth/v1/admin/users",
            headers=HEADERS,
            json={
                "email": email,
                "password": password,
                "email_confirm": True,
                "user_metadata": {"full_name": full_name},
            },
            timeout=20,
        )

        if not auth.ok:
            print(f"  ERROR creating login: {auth.status_code} {auth.text}")
            failed += 1
            continue

        user_id = auth.json().get("id")

        profile = requests.post(
            f"{SUPABASE_URL}/rest/v1/profiles",
            headers={**HEADERS, "Prefer": "return=representation"},
            json={
                "id": user_id,
                "email": email,
                "full_name": full_name,
                "role": role,
                "company_id": company_id,
                "active": True,
                "is_activity_admin": False,
                "must_change_password": True,
            },
            timeout=20,
        )

        if not profile.ok:
            # Roll back the Auth user if the profile failed.
            requests.delete(
                f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
                headers=HEADERS,
                timeout=20,
            )
            print(f"  ERROR creating profile: {profile.status_code} {profile.text}")
            failed += 1
            continue

        print("  CREATED")
        created += 1

print(f"\nFinished: {created} created, {skipped} skipped, {failed} failed.")
