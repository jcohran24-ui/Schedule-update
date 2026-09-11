import os
import io
import smtplib
import ssl
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr
from functools import wraps
import requests
from flask import Flask, jsonify, render_template, request, send_from_directory, send_file

app = Flask(__name__)
SUPABASE_URL = os.getenv('SUPABASE_URL', '').rstrip('/')
SUPABASE_ANON_KEY = os.getenv('SUPABASE_ANON_KEY', '')
SUPABASE_SERVICE_ROLE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY', '')

SMTP_HOST = os.getenv('SMTP_HOST', '').strip()
SMTP_PORT = int(os.getenv('SMTP_PORT', '587') or '587')
SMTP_USERNAME = os.getenv('SMTP_USERNAME', '').strip()
SMTP_PASSWORD = os.getenv('SMTP_PASSWORD', '')
SMTP_FROM_EMAIL = os.getenv('SMTP_FROM_EMAIL', SMTP_USERNAME).strip()
SMTP_FROM_NAME = os.getenv('SMTP_FROM_NAME', 'CTCC Oasis Schedule').strip()
SMTP_USE_SSL = os.getenv('SMTP_USE_SSL', '').strip().lower() in ('1', 'true', 'yes', 'on')
APP_PUBLIC_URL = os.getenv('APP_PUBLIC_URL', '').strip().rstrip('/')


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


@app.route('/sw.js')
def service_worker():
    response = send_from_directory(app.static_folder, 'sw.js', mimetype='application/javascript')
    response.headers['Service-Worker-Allowed'] = '/'
    response.headers['Cache-Control'] = 'no-cache'
    return response


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


@app.route('/api/admin/user/<user_id>/role', methods=['PATCH'])
def set_user_role(user_id):
    """Update an existing user's role while preserving their current login and password."""
    if not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({'error': 'Service role key is not configured'}), 500
    acting_user, err = verify_gc_admin(request.headers.get('Authorization'))
    if err:
        return jsonify({'error': err[0]}), err[1]

    data = request.get_json(silent=True) or {}
    role = data.get('role')
    company_id = data.get('company_id') or None
    if role not in ('gc_admin', 'gc', 'sub'):
        return jsonify({'error': 'Invalid role'}), 400
    if role == 'sub' and not company_id:
        return jsonify({'error': 'Subcontractor users must be assigned to a company'}), 400
    if role in ('gc', 'gc_admin'):
        company_id = None

    acting_uid = (acting_user or {}).get('id')
    if user_id == acting_uid and role != 'gc_admin':
        return jsonify({'error': 'You cannot remove your own GC Admin access'}), 400

    headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type': 'application/json',
    }

    # Make sure the target profile exists before updating it.
    lookup = requests.get(
        f'{SUPABASE_URL}/rest/v1/profiles',
        params={'id': f'eq.{user_id}', 'select': 'id,is_activity_admin'},
        headers=headers,
        timeout=15,
    )
    rows = lookup.json() if lookup.ok else []
    if not rows:
        return jsonify({'error': 'User profile not found'}), 404

    resp = requests.patch(
        f'{SUPABASE_URL}/rest/v1/profiles',
        params={'id': f'eq.{user_id}'},
        headers={**headers, 'Prefer': 'return=minimal'},
        json={'role': role, 'company_id': company_id},
        timeout=15,
    )
    if not resp.ok:
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text
        return jsonify({'error': 'Could not update user role', 'detail': detail}), resp.status_code

    return jsonify({'ok': True, 'role': role, 'company_id': company_id})


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


def send_foreman_email(to_email, to_name, company_name, app_url):
    if not SMTP_HOST or not SMTP_FROM_EMAIL:
        raise RuntimeError('Email is not configured. Add SMTP settings in Render.')

    greeting = f'Good morning {to_name},' if to_name else 'Good morning,'
    company_line = f' for {company_name}' if company_name else ''

    msg = EmailMessage()
    msg['Subject'] = 'CTCC Oasis – 4-Week Look Ahead Update'
    msg['From'] = formataddr((SMTP_FROM_NAME, SMTP_FROM_EMAIL))
    msg['To'] = to_email
    msg.set_content(f"""{greeting}

Please log into the CTCC Oasis Schedule Update app and review your company’s activities{company_line}.

Please:
1. Select the 4-Week Look Ahead filter.
2. Review all activities assigned to your company.
3. Update any activities that have started or been completed.
4. Update the current start/finish dates where applicable.
5. If an activity is assigned to your company that does not belong to your scope, please let me know so I can correct it.

Schedule Update App:
{app_url}

Please keep the schedule updated so we have accurate information for coordination and upcoming work.

Thank you,
Jody Cohran
New South Construction
""")
    msg.add_alternative(f"""<html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#222">
<p>{greeting}</p>
<p>Please log into the <strong>CTCC Oasis Schedule Update</strong> app and review your company’s activities{company_line}.</p>
<ol>
<li>Select the <strong>4-Week Look Ahead</strong> filter.</li>
<li>Review all activities assigned to your company.</li>
<li>Update any activities that have <strong>started or been completed</strong>.</li>
<li>Update the current start/finish dates where applicable.</li>
<li>If an activity is assigned to your company that <strong>does not belong to your scope</strong>, please let me know so I can correct it.</li>
</ol>
<p><a href="{app_url}" style="display:inline-block;padding:10px 16px;background:#1f6feb;color:white;text-decoration:none;border-radius:6px">Open Schedule Update App</a></p>
<p>Please keep the schedule updated so we have accurate information for coordination and upcoming work.</p>
<p>Thank you,<br><strong>Jody Cohran</strong><br>New South Construction</p>
</body></html>""", subtype='html')

    if SMTP_USE_SSL or SMTP_PORT == 465:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context, timeout=30) as smtp:
            if SMTP_USERNAME:
                smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
            smtp.send_message(msg)
    else:
        context = ssl.create_default_context()
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as smtp:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
            if SMTP_USERNAME:
                smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
            smtp.send_message(msg)


@app.route('/api/admin/email-foremen', methods=['POST'])
def email_foremen():
    if not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({'error': 'Service role key is not configured'}), 500
    _, err = verify_gc_admin(request.headers.get('Authorization'))
    if err:
        return jsonify({'error': err[0]}), err[1]
    if not SMTP_HOST or not SMTP_FROM_EMAIL:
        return jsonify({'error': 'Email is not configured yet. Add the SMTP settings in Render first.'}), 500

    headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
    }
    p_resp = requests.get(
        f'{SUPABASE_URL}/rest/v1/profiles',
        params={
            'role': 'eq.sub',
            'active': 'eq.true',
            'select': 'id,email,full_name,company_id',
            'order': 'full_name.asc',
        },
        headers=headers,
        timeout=20,
    )
    if not p_resp.ok:
        return jsonify({'error': 'Could not load active subcontractor users'}), 500

    c_resp = requests.get(
        f'{SUPABASE_URL}/rest/v1/companies',
        params={'select': 'id,company_name'},
        headers=headers,
        timeout=20,
    )
    companies = c_resp.json() if c_resp.ok else []
    company_map = {c.get('id'): c.get('company_name', '') for c in companies}

    recipients = [p for p in (p_resp.json() or []) if (p.get('email') or '').strip()]
    if not recipients:
        return jsonify({'error': 'No active subcontractor users with email addresses were found'}), 400

    app_url = APP_PUBLIC_URL or request.host_url.rstrip('/')
    sent = []
    failed = []
    for p in recipients:
        email = (p.get('email') or '').strip().lower()
        try:
            send_foreman_email(
                email,
                (p.get('full_name') or '').strip(),
                company_map.get(p.get('company_id'), ''),
                app_url,
            )
            sent.append(email)
        except Exception as exc:
            failed.append({'email': email, 'error': str(exc)})

    return jsonify({
        'ok': bool(sent),
        'sent_count': len(sent),
        'failed_count': len(failed),
        'sent': sent,
        'failed': failed,
    }), (200 if sent else 500)


def verify_logged_in(auth_header):
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
    user = user_resp.json() or {}
    if not user.get('id'):
        return None, ('Invalid user', 401)
    return user, None


def _pdf_date(value):
    if not value:
        return '-'
    try:
        return datetime.strptime(value, '%Y-%m-%d').strftime('%-m/%-d/%Y')
    except Exception:
        try:
            return datetime.strptime(value, '%Y-%m-%d').strftime('%m/%d/%Y').lstrip('0').replace('/0','/')
        except Exception:
            return str(value)


def _variance_label(value):
    if value is None:
        return '-'
    try:
        n = int(value)
    except Exception:
        return '-'
    if n == 0:
        return '0d'
    return f'+{n}d late' if n > 0 else f'{abs(n)}d early'


@app.route('/api/export/lookahead-pdf', methods=['POST'])
def export_lookahead_pdf():
    user, err = verify_logged_in(request.headers.get('Authorization'))
    if err:
        return jsonify({'error': err[0]}), err[1]

    data = request.get_json(silent=True) or {}
    rows = data.get('rows') or []
    if not isinstance(rows, list) or not rows:
        return jsonify({'error': 'No activities were supplied for the PDF'}), 400
    if len(rows) > 2000:
        return jsonify({'error': 'Too many activities for one PDF export'}), 400

    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_LEFT
        from reportlab.lib.pagesizes import letter, landscape
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import inch
        from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, KeepTogether
    except Exception:
        return jsonify({'error': 'PDF support is not installed on the server'}), 500

    project_name = str(data.get('project_name') or 'CTCC Oasis')[:120]
    range_weeks = 6 if int(data.get('range_weeks') or 4) == 6 else 4
    trade_name = str(data.get('trade_name') or 'All Trades')[:120]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=landscape(letter),
        rightMargin=0.28*inch, leftMargin=0.28*inch,
        topMargin=0.35*inch, bottomMargin=0.32*inch,
        title=f'{project_name} - {range_weeks}-Week Look Ahead',
        author='Schedule Update',
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle('ExportTitle', parent=styles['Title'], fontName='Helvetica-Bold', fontSize=15, leading=18, textColor=colors.HexColor('#173A63'), spaceAfter=2)
    meta_style = ParagraphStyle('ExportMeta', parent=styles['Normal'], fontName='Helvetica', fontSize=7.5, leading=9, textColor=colors.HexColor('#52606D'), spaceAfter=6)
    trade_style = ParagraphStyle('TradeHeader', parent=styles['Heading2'], fontName='Helvetica-Bold', fontSize=10, leading=12, textColor=colors.white, backColor=colors.HexColor('#173A63'), leftIndent=5, spaceBefore=6, spaceAfter=3)
    cell_style = ParagraphStyle('Cell', parent=styles['Normal'], fontName='Helvetica', fontSize=6.5, leading=8, textColor=colors.HexColor('#172B4D'))
    small_style = ParagraphStyle('SmallCell', parent=cell_style, fontSize=6.2, leading=7.3)
    header_style = ParagraphStyle('HeaderCell', parent=cell_style, fontName='Helvetica-Bold', textColor=colors.white, alignment=TA_LEFT)

    story = [
        Paragraph(f'{project_name} - {range_weeks}-Week Look Ahead', title_style),
        Paragraph(f'{trade_name} &nbsp;&nbsp;|&nbsp;&nbsp; Generated {datetime.now().strftime("%m/%d/%Y %I:%M %p")} &nbsp;&nbsp;|&nbsp;&nbsp; {len(rows)} activities', meta_style),
    ]

    groups = {}
    for row in rows:
        trade = str(row.get('trade') or 'Unassigned')
        groups.setdefault(trade, []).append(row)

    for trade in sorted(groups, key=lambda x: x.lower()):
        story.append(Paragraph(trade, trade_style))
        table_rows = [[
            Paragraph('ID / Area', header_style),
            Paragraph('Activity', header_style),
            Paragraph('Baseline', header_style),
            Paragraph('Current', header_style),
            Paragraph('Status', header_style),
            Paragraph('Variance', header_style),
            Paragraph('Notes', header_style),
        ]]
        for row in groups[trade]:
            code = str(row.get('activity_code') or '')
            area = str(row.get('area') or '')
            id_area = code + (f'<br/><font color="#52606D">{area}</font>' if area else '')
            baseline = f'{_pdf_date(row.get("baseline_start"))}<br/>{_pdf_date(row.get("baseline_finish"))}'
            current = f'{_pdf_date(row.get("current_start"))}<br/>{_pdf_date(row.get("current_finish"))}'
            status = str(row.get('status') or '')
            pct = row.get('percent')
            if status == 'In Progress' and pct is not None:
                status = f'{status}<br/>{int(pct)}%'
            notes = str(row.get('notes') or '').replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
            name = str(row.get('activity_name') or '').replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
            table_rows.append([
                Paragraph(id_area, small_style),
                Paragraph(name, cell_style),
                Paragraph(baseline, small_style),
                Paragraph(current, small_style),
                Paragraph(status, small_style),
                Paragraph(_variance_label(row.get('variance_days')), small_style),
                Paragraph(notes or '-', small_style),
            ])
        col_widths = [0.78*inch, 2.25*inch, 0.92*inch, 0.92*inch, 0.78*inch, 0.75*inch, 3.15*inch]
        t = Table(table_rows, colWidths=col_widths, repeatRows=1, hAlign='LEFT')
        t.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,0),colors.HexColor('#2F5D8C')),
            ('TEXTCOLOR',(0,0),(-1,0),colors.white),
            ('VALIGN',(0,0),(-1,-1),'TOP'),
            ('GRID',(0,0),(-1,-1),0.25,colors.HexColor('#D9E2EC')),
            ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F7F9FC')]),
            ('LEFTPADDING',(0,0),(-1,-1),3),
            ('RIGHTPADDING',(0,0),(-1,-1),3),
            ('TOPPADDING',(0,0),(-1,-1),3),
            ('BOTTOMPADDING',(0,0),(-1,-1),3),
        ]))
        story.append(t)
        story.append(Spacer(1, 0.05*inch))

    def add_page_number(canvas, doc_obj):
        canvas.saveState()
        canvas.setFont('Helvetica', 6.5)
        canvas.setFillColor(colors.HexColor('#6B778C'))
        canvas.drawRightString(landscape(letter)[0]-0.28*inch, 0.16*inch, f'Page {doc_obj.page}')
        canvas.restoreState()

    doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)
    buf.seek(0)
    safe_trade = ''.join(ch if ch.isalnum() or ch in ('-','_') else '_' for ch in trade_name).strip('_') or 'All_Trades'
    filename = f'{range_weeks}-Week_Lookahead_{safe_trade}.pdf'
    return send_file(buf, mimetype='application/pdf', as_attachment=True, download_name=filename, max_age=0)


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
