import os
from functools import wraps
import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)
SUPABASE_URL = os.getenv('SUPABASE_URL', '').rstrip('/')
SUPABASE_ANON_KEY = os.getenv('SUPABASE_ANON_KEY', '')
SUPABASE_SERVICE_ROLE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY', '')


def configured():
    return bool(SUPABASE_URL and SUPABASE_ANON_KEY)


def verify_gc_admin(auth_header):
    if not auth_header or not auth_header.lower().startswith('bearer '):
        return None, ('Missing login token', 401)
    token = auth_header.split(' ', 1)[1].strip()
    user_resp = requests.get(
        f'{SUPABASE_URL}/auth/v1/user',
        headers={'apikey': SUPABASE_ANON_KEY, 'Authorization': f'Bearer {token}'},
        timeout=15,
    )
    if user_resp.status_code != 200:
        return None, ('Invalid or expired login', 401)
    user = user_resp.json()
    uid = user.get('id')
    if not uid:
        return None, ('Invalid user', 401)
    profile_resp = requests.get(
        f'{SUPABASE_URL}/rest/v1/profiles',
        params={'id': f'eq.{uid}', 'select': 'id,role'},
        headers={
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        },
        timeout=15,
    )
    rows = profile_resp.json() if profile_resp.ok else []
    if not rows or rows[0].get('role') != 'gc_admin':
        return None, ('GC Admin access required', 403)
    return user, None


@app.route('/')
def index():
    return render_template(
        'index.html',
        supabase_url=SUPABASE_URL,
        supabase_anon_key=SUPABASE_ANON_KEY,
        is_configured=configured(),
    )


@app.route('/health')
def health():
    return jsonify({'ok': True, 'configured': configured()})


@app.route('/api/admin/create-user', methods=['POST'])
def create_user():
    if not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({'error': 'SUPABASE_SERVICE_ROLE_KEY is not configured'}), 500
    user, err = verify_gc_admin(request.headers.get('Authorization'))
    if err:
        return jsonify({'error': err[0]}), err[1]

    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''
    full_name = (data.get('full_name') or '').strip()
    role = data.get('role')
    company_id = data.get('company_id') or None

    if not email or len(password) < 8 or role not in ('gc_admin', 'gc', 'sub'):
        return jsonify({'error': 'Email, 8+ character password, and valid role are required'}), 400
    if role == 'sub' and not company_id:
        return jsonify({'error': 'Subcontractor users must be assigned to a company'}), 400
    if role in ('gc', 'gc_admin'):
        company_id = None

    admin_headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type': 'application/json',
    }
    create_resp = requests.post(
        f'{SUPABASE_URL}/auth/v1/admin/users',
        headers=admin_headers,
        json={
            'email': email,
            'password': password,
            'email_confirm': True,
            'user_metadata': {'full_name': full_name},
        },
        timeout=20,
    )
    if not create_resp.ok:
        try:
            detail = create_resp.json()
        except Exception:
            detail = create_resp.text
        return jsonify({'error': 'Could not create login', 'detail': detail}), create_resp.status_code

    new_user = create_resp.json()
    new_uid = new_user.get('id')
    profile_resp = requests.post(
        f'{SUPABASE_URL}/rest/v1/profiles',
        headers={**admin_headers, 'Prefer': 'return=representation'},
        json={
            'id': new_uid,
            'email': email,
            'full_name': full_name,
            'role': role,
            'company_id': company_id,
            'active': True,
            'must_change_password': True,
        },
        timeout=15,
    )
    if not profile_resp.ok:
        requests.delete(f'{SUPABASE_URL}/auth/v1/admin/users/{new_uid}', headers=admin_headers, timeout=15)
        return jsonify({'error': 'Login created but profile setup failed; login was rolled back'}), 500
    return jsonify({'ok': True, 'user_id': new_uid})


@app.route('/api/admin/user/<user_id>', methods=['DELETE'])
def delete_user(user_id):
    """Permanently delete a managed user. GC Admin only; cannot delete self or Activity Admin."""
    if not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({'error': 'Service role key is not configured'}), 500
    acting_user, err = verify_gc_admin(request.headers.get('Authorization'))
    if err:
        return jsonify({'error': err[0]}), err[1]

    acting_uid = (acting_user or {}).get('id')
    if user_id == acting_uid:
        return jsonify({'error': 'You cannot delete your own admin account'}), 400

    headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type': 'application/json',
    }

    # Protect the Activity Admin account from accidental deletion.
    profile_resp = requests.get(
        f'{SUPABASE_URL}/rest/v1/profiles',
        params={'id': f'eq.{user_id}', 'select': 'id,email,full_name,is_activity_admin'},
        headers=headers,
        timeout=15,
    )
    rows = profile_resp.json() if profile_resp.ok else []
    if rows and rows[0].get('is_activity_admin') is True:
        return jsonify({'error': 'The Activity Admin account cannot be deleted'}), 400

    resp = requests.delete(
        f'{SUPABASE_URL}/auth/v1/admin/users/{user_id}',
        headers=headers,
        timeout=20,
    )
    if not resp.ok:
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text
        return jsonify({'error': 'Could not delete user', 'detail': detail}), resp.status_code

    # profiles.id references auth.users(id) ON DELETE CASCADE, so the profile is removed automatically.
    return jsonify({'ok': True})


@app.route('/api/admin/user/<user_id>/active', methods=['PATCH'])
def set_user_active(user_id):
    if not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({'error': 'Service role key is not configured'}), 500
    _, err = verify_gc_admin(request.headers.get('Authorization'))
    if err:
        return jsonify({'error': err[0]}), err[1]
    data = request.get_json(silent=True) or {}
    active = bool(data.get('active'))
    headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type': 'application/json',
    }
    p = requests.patch(
        f'{SUPABASE_URL}/rest/v1/profiles',
        params={'id': f'eq.{user_id}'},
        headers={**headers, 'Prefer': 'return=minimal'},
        json={'active': active},
        timeout=15,
    )
    if not p.ok:
        return jsonify({'error': 'Could not update user'}), 500
    # ban/unban at auth layer too
    ban_duration = 'none' if active else '876000h'
    requests.put(
        f'{SUPABASE_URL}/auth/v1/admin/users/{user_id}',
        headers=headers,
        json={'ban_duration': ban_duration},
        timeout=15,
    )
    return jsonify({'ok': True})


@app.route('/api/admin/user/<user_id>/password', methods=['PATCH'])
def set_user_password(user_id):
    if not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({'error': 'Service role key is not configured'}), 500
    _, err = verify_gc_admin(request.headers.get('Authorization'))
    if err:
        return jsonify({'error': err[0]}), err[1]

    data = request.get_json(silent=True) or {}
    password = data.get('password') or ''
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400

    headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type': 'application/json',
    }
    resp = requests.put(
        f'{SUPABASE_URL}/auth/v1/admin/users/{user_id}',
        headers=headers,
        json={'password': password},
        timeout=20,
    )
    if not resp.ok:
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text
        return jsonify({'error': 'Could not update password', 'detail': detail}), resp.status_code
    return jsonify({'ok': True})


@app.route('/api/account/password-changed', methods=['POST'])
def password_changed():
    """Clear the first-login password-change requirement for the signed-in user."""
    if not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({'error': 'Service role key is not configured'}), 500
    auth_header = request.headers.get('Authorization')
    if not auth_header or not auth_header.lower().startswith('bearer '):
        return jsonify({'error': 'Missing login token'}), 401
    token = auth_header.split(' ', 1)[1].strip()
    user_resp = requests.get(
        f'{SUPABASE_URL}/auth/v1/user',
        headers={'apikey': SUPABASE_ANON_KEY, 'Authorization': f'Bearer {token}'},
        timeout=15,
    )
    if user_resp.status_code != 200:
        return jsonify({'error': 'Invalid or expired login'}), 401
    uid = (user_resp.json() or {}).get('id')
    if not uid:
        return jsonify({'error': 'Invalid user'}), 401
    headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
    }
    resp = requests.patch(
        f'{SUPABASE_URL}/rest/v1/profiles',
        params={'id': f'eq.{uid}'},
        headers=headers,
        json={'must_change_password': False},
        timeout=15,
    )
    if not resp.ok:
        return jsonify({'error': 'Password changed, but account setup could not be finalized'}), 500
    return jsonify({'ok': True})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', '10000')), debug=True)
