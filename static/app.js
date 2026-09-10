const cfg = window.APP_CONFIG || {};
const sb = cfg.supabaseUrl && cfg.supabaseAnonKey
  ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
  : null;

let session = null;
let profile = null;
let projects = [];
let companies = [];
let activities = [];
let profiles = [];
let selectedProjectId = null;
let currentRange = 'all';
let subStatusFilter = '';
let saveAndNextRequested = false;
let gcMobileIssuesOnly = false;
let subChangedActivityIds = new Set();

const $ = (id) => document.getElementById(id);
const fmt = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString() : '—';
const isoDate = (d) => d.toISOString().slice(0,10);
function baselineWorkdays(start, finish){
  if(!start || !finish) return null;
  let s=new Date(start+'T12:00:00'), f=new Date(finish+'T12:00:00');
  if(isNaN(s)||isNaN(f)||f<s) return null;
  let n=0;
  for(let d=new Date(s); d<=f; d.setDate(d.getDate()+1)){
    const day=d.getDay(); if(day!==0 && day!==6) n++;
  }
  return n;
}
function baselineDuration(a){
  return a.duration_days ?? baselineWorkdays(a.original_start,a.original_finish);
}
function finishFromStartAndDuration(start, duration){
  if(!start || duration===null || duration===undefined || duration==='') return '';
  const days=Number(duration);
  if(!Number.isFinite(days) || days<=0) return '';
  let d=new Date(start+'T12:00:00');
  if(isNaN(d)) return '';
  // Treat Current Start as workday 1 and skip Saturdays/Sundays.
  while(d.getDay()===0 || d.getDay()===6) d.setDate(d.getDate()+1);
  let counted=1;
  while(counted<days){
    d.setDate(d.getDate()+1);
    const day=d.getDay();
    if(day!==0 && day!==6) counted++;
  }
  return isoDate(d);
}
function startFromFinishAndDuration(finish, duration){
  if(!finish || duration===null || duration===undefined || duration==='') return '';
  const days=Number(duration);
  if(!Number.isFinite(days) || days<=0) return '';
  let d=new Date(finish+'T12:00:00');
  if(isNaN(d)) return '';
  // Treat Current Finish as the final workday and skip Saturdays/Sundays backwards.
  while(d.getDay()===0 || d.getDay()===6) d.setDate(d.getDate()-1);
  let counted=1;
  while(counted<days){
    d.setDate(d.getDate()-1);
    const day=d.getDay();
    if(day!==0 && day!==6) counted++;
  }
  return isoDate(d);
}
function elapsedWorkdays(start, endDate=new Date()){
  if(!start) return 0;
  let s=new Date(start+'T12:00:00');
  let e=endDate instanceof Date ? new Date(endDate) : new Date(String(endDate)+'T12:00:00');
  e.setHours(12,0,0,0);
  if(isNaN(s)||isNaN(e)||e<s) return 0;
  let n=0;
  for(let d=new Date(s); d<=e; d.setDate(d.getDate()+1)){
    const day=d.getDay(); if(day!==0 && day!==6) n++;
  }
  return n;
}
function calculateSchedulePercent(status,start,duration,stored=0,auto=true,finish=''){
  if(status==='Complete') return 100;
  if(status==='Not Started' || !start) return 0;
  if(auto){
    // If Current Start + Current Finish are both present, use that current workday span.
    // Otherwise fall back to the activity duration.
    const currentSpan = finish ? baselineWorkdays(start,finish) : null;
    const totalDays = Number(currentSpan)>0 ? Number(currentSpan) : Number(duration);
    if(totalDays>0){
      const elapsed=elapsedWorkdays(start);
      if(elapsed<=0) return 0;
      return Math.min(99, Math.max(1, Math.round((elapsed/totalDays)*100)));
    }
  }
  return Number(stored||0);
}
function effectivePercent(a){
  if(!a) return 0;
  return calculateSchedulePercent(a.status,a.current_start,baselineDuration(a),a.percent_complete,a.auto_percent!==false,a.current_finish);
}
function effectivePercentFromForm({status,start,finish='',duration,stored=0,auto=true}){
  return calculateSchedulePercent(status,start,duration,stored,auto,finish);
}
function refreshEditAutoPercent(){
  const id=$('editId')?.value;
  const a=activities.find(x=>x.id===id);
  if(!a) return;
  const status=$('editStatus').value;
  const pct=calculateSchedulePercent(status,$('editStart').value,baselineDuration(a),0,true,$('editFinish').value);
  const display=$('editPercentDisplay'); if(display) display.textContent=`${pct}%`;
  const note=$('editPercentAutoNote'); if(note) note.textContent=status==='Complete'?'Complete = 100%':($('editStart').value?'Calculated from elapsed workdays and current date span':'Enter Current Start to calculate progress');
}
function refreshAdminAutoPercent(){
  const status=$('adminStatus')?.value;
  const auto=$('adminAutoPercent')?.checked!==false;
  const duration=$('adminDuration')?.value;
  const pct=effectivePercentFromForm({status,start:$('adminCurrentStart')?.value,finish:$('adminCurrentFinish')?.value,duration,stored:$('adminPercent')?.value,auto});
  if($('adminPercent')){
    $('adminPercent').value=pct;
    $('adminPercent').disabled=(auto && status==='In Progress') || status==='Complete';
  }
  const note=$('adminPercentAutoNote'); if(note) note.textContent=(auto && status==='In Progress')?'Auto based on current date span':'Manual';
}
function autoFillEditFinish(){
  const id=$('editId')?.value;
  const a=activities.find(x=>x.id===id);
  if(!a) return;
  const finish=finishFromStartAndDuration($('editStart').value, baselineDuration(a));
  if(finish) $('editFinish').value=finish;
}
function autoFillAdminFinish(){
  const finish=finishFromStartAndDuration($('adminCurrentStart')?.value, $('adminDuration')?.value);
  if(finish && $('adminCurrentFinish')) $('adminCurrentFinish').value=finish;
}
function autoFillEditStart(){
  const id=$('editId')?.value;
  const a=activities.find(x=>x.id===id);
  if(!a || $('editStart')?.value) return;
  const start=startFromFinishAndDuration($('editFinish')?.value, baselineDuration(a));
  if(start) $('editStart').value=start;
}
function autoFillAdminStart(){
  if($('adminCurrentStart')?.value) return;
  const start=startFromFinishAndDuration($('adminCurrentFinish')?.value, $('adminDuration')?.value);
  if(start && $('adminCurrentStart')) $('adminCurrentStart').value=start;
}
const esc = (s='') => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function toast(msg){ const el=$('toast'); el.textContent=msg; el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'),2600); }
function isGC(){ return profile && ['gc','gc_admin'].includes(profile.role); }
function isAdmin(){ return profile && profile.role === 'gc_admin'; }
function isActivityAdmin(){ return profile && profile.is_activity_admin === true; }
function canUpdateActivity(){ return profile && (profile.role === 'sub' || isActivityAdmin()); }
function isSub(){ return profile && profile.role === 'sub'; }
function companyName(id){ return companies.find(c=>c.id===id)?.company_name || 'Unassigned'; }
function profileName(id){ return profiles.find(p=>p.id===id)?.full_name || profiles.find(p=>p.id===id)?.email || 'User'; }

async function init(){
  if(!sb) return;
  const {data:{session:s}} = await sb.auth.getSession();
  if(s) await enterApp(s);
  sb.auth.onAuthStateChange(async (_event,sess)=>{ if(sess && !session) await enterApp(sess); });
}

$('loginForm')?.addEventListener('submit', async e=>{
  e.preventDefault(); $('loginError').textContent='';
  const {data,error}=await sb.auth.signInWithPassword({email:$('loginEmail').value.trim(),password:$('loginPassword').value});
  if(error){$('loginError').textContent=error.message;return;}
  await enterApp(data.session);
});
$('logoutBtn')?.addEventListener('click', async()=>{await sb.auth.signOut(); location.reload();});

$('forcePasswordLogout')?.addEventListener('click', async()=>{await sb.auth.signOut(); location.reload();});
$('forcePasswordForm')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const errEl=$('forcePasswordError');
  errEl.textContent='';
  const password=$('forceNewPassword').value;
  const confirm=$('forceConfirmPassword').value;
  if(password.length<8){errEl.textContent='Password must be at least 8 characters.';return;}
  if(password!==confirm){errEl.textContent='Passwords do not match.';return;}
  const {error}=await sb.auth.updateUser({password});
  if(error){errEl.textContent=error.message;return;}
  const {data:{session:latestSession}}=await sb.auth.getSession();
  if(!latestSession){errEl.textContent='Your login expired. Please sign in again.';return;}
  const r=await fetch('/api/account/password-changed',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${latestSession.access_token}`},
    body:'{}'
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok){errEl.textContent=data.error||'Password changed, but setup could not be completed. Please contact an admin.';return;}
  profile.must_change_password=false;
  session=latestSession;
  toast('Password changed');
  await enterApp(latestSession);
});

async function enterApp(s){
  session=s;
  const {data:p,error}=await sb.from('profiles').select('*').eq('id',s.user.id).single();
  if(error || !p || !p.active){ await sb.auth.signOut(); $('loginError').textContent='Your account is not active or has not been assigned a profile.'; return; }
  profile=p;
  $('loginScreen').classList.add('hidden');
  if(p.must_change_password){
    $('appScreen').classList.add('hidden');
    $('forcePasswordScreen').classList.remove('hidden');
    $('forcePasswordError').textContent='';
    $('forceNewPassword').value='';
    $('forceConfirmPassword').value='';
    setTimeout(()=>$('forceNewPassword')?.focus(),50);
    return;
  }
  $('forcePasswordScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
  document.body.classList.toggle('sub-mode',p.role==='sub');
  document.body.classList.toggle('gc-mode',isGC());
  $('userBadge').textContent=`${p.full_name || p.email} • ${p.role==='sub'?'Subcontractor':p.role==='gc_admin'?'GC Admin':'GC'}${p.is_activity_admin?' • Activity Editor':''}`;
  document.querySelectorAll('.gc-only').forEach(el=>el.classList.toggle('hidden',!isGC()));
  document.querySelectorAll('.admin-only').forEach(el=>el.classList.toggle('hidden',!(isAdmin() || isActivityAdmin())));
  document.querySelectorAll('.gc-admin-only').forEach(el=>el.classList.toggle('hidden',!isAdmin()));
  document.querySelectorAll('.activity-admin-only').forEach(el=>el.classList.toggle('hidden',!isActivityAdmin()));
  $('scheduleTitle').textContent = p.role==='sub' ? 'My Activities' : 'Remaining Schedule';
  if(p.role==='sub'){
    currentRange='4';
    document.querySelectorAll('.range-btn').forEach(x=>x.classList.toggle('active',x.dataset.range==='4'));
  }
  await loadReferenceData();
  await loadActivities();
}

async function loadReferenceData(){
  let {data:pr}=await sb.from('projects').select('*').order('project_name'); projects=pr||[];
  let {data:co}=await sb.from('companies').select('*').order('company_name'); companies=co||[];
  if(isGC()){ let {data:pf}=await sb.from('profiles').select('*').order('full_name'); profiles=pf||[]; }
  renderProjectOptions(); renderCompanies(); renderUsers(); renderAdminActivities(); updateAdminSummary();
  if(!selectedProjectId && projects.length) selectedProjectId=projects[0].id;
  if(selectedProjectId) $('projectSelect').value=selectedProjectId;
  updateProjectLabel();
}

function renderProjectOptions(){
  $('projectSelect').innerHTML = projects.length ? projects.map(p=>`<option value="${p.id}">${esc(p.project_name)}</option>`).join('') : '<option value="">No projects</option>';
  $('projectList').innerHTML = projects.map(p=>`<div class="mini-row"><span>${esc(p.project_name)}</span><span>${p.active?'Active':'Inactive'}</span></div>`).join('');
}
function renderCompanies(){
  if($('tradeFilter')){
    const current=$('tradeFilter').value;
    $('tradeFilter').innerHTML='<option value="">All Trades</option>'+companies.map(c=>`<option value="${c.id}">${esc(c.company_name)}</option>`).join('')+'<option value="__unassigned">Unassigned</option>';
    $('tradeFilter').value=current;
  }
  if($('userCompany')) $('userCompany').innerHTML='<option value="">Select company</option>'+companies.map(c=>`<option value="${c.id}">${esc(c.company_name)}</option>`).join('');
  if($('companyList')) $('companyList').innerHTML=companies.map(c=>`<div class="mini-row"><span>${esc(c.company_name)}</span><span>${esc(c.trade||'')}</span></div>`).join('');
  if($('companiesTradesCount')) $('companiesTradesCount').textContent=`${companies.length} ${companies.length===1?'company':'companies'}`;
}

function setCompaniesTradesCollapsed(collapsed){
  const body=$('companiesTradesBody'), toggle=$('companiesTradesToggle');
  if(!body || !toggle) return;
  body.classList.toggle('hidden',collapsed);
  toggle.setAttribute('aria-expanded',String(!collapsed));
  const arrow=toggle.querySelector('.card-collapse-arrow');
  if(arrow) arrow.textContent=collapsed?'▶':'▼';
  try{localStorage.setItem('adminCompaniesTradesCollapsed',collapsed?'1':'0');}catch(e){}
}
function initCompaniesTradesCollapse(){
  const toggle=$('companiesTradesToggle');
  if(!toggle) return;
  let collapsed=false;
  try{collapsed=localStorage.getItem('adminCompaniesTradesCollapsed')==='1';}catch(e){}
  setCompaniesTradesCollapsed(collapsed);
  toggle.onclick=()=>setCompaniesTradesCollapsed(toggle.getAttribute('aria-expanded')==='true');
}
function renderUsers(){
  if(!isAdmin() || !$('userBody')) return;
  const q=String($('adminUserSearch')?.value||'').trim().toLowerCase();
  const shown=profiles.filter(p=>{
    if(!q) return true;
    const hay=[p.full_name,p.email,p.role,companyName(p.company_id)].map(x=>String(x||'').toLowerCase()).join(' ');
    return hay.includes(q);
  });
  $('userBody').innerHTML=shown.map(p=>{
    const protectedUser = p.id===profile?.id || p.is_activity_admin===true;
    const deleteButton = protectedUser
      ? '<button class="danger" type="button" disabled title="This admin account is protected">Delete</button>'
      : `<button class="danger delete-user" type="button" data-id="${p.id}">Delete</button>`;
    return `<tr><td>${esc(p.full_name||'')}</td><td>${esc(p.email||'')}</td><td>${esc(p.role)}</td><td>${esc(companyName(p.company_id))}</td><td>${p.active?'Yes':'No'}</td><td class="user-actions"><button class="ghost set-password" data-id="${p.id}">Set Password</button> <button class="ghost toggle-user" data-id="${p.id}" data-active="${p.active}">${p.active?'Deactivate':'Activate'}</button> ${deleteButton}</td></tr>`;
  }).join('');
  if(!shown.length) $('userBody').innerHTML='<tr><td colspan="6" class="muted">No users match this search.</td></tr>';
  document.querySelectorAll('.toggle-user').forEach(b=>b.onclick=()=>toggleUser(b.dataset.id,b.dataset.active!=='true'));
  document.querySelectorAll('.set-password').forEach(b=>b.onclick=()=>openPasswordModal(b.dataset.id));
  document.querySelectorAll('.delete-user').forEach(b=>b.onclick=()=>deleteUser(b.dataset.id));
}

function updateAdminSummary(){
  const activeUsers=profiles.filter(p=>p.active).length;
  const inactiveUsers=profiles.filter(p=>!p.active).length;
  const projectActs=selectedProjectId ? activities.filter(a=>a.project_id===selectedProjectId || !a.project_id) : activities;
  const unassigned=projectActs.filter(a=>!a.company_id).length;
  if($('adminActiveUsersCount')) $('adminActiveUsersCount').textContent=activeUsers;
  if($('adminInactiveUsersCount')) $('adminInactiveUsersCount').textContent=`${inactiveUsers} inactive`;
  if($('adminCompaniesCount')) $('adminCompaniesCount').textContent=companies.length;
  if($('adminActivitiesCount')) $('adminActivitiesCount').textContent=projectActs.length;
  if($('adminUnassignedCount')) $('adminUnassignedCount').textContent=`${unassigned} unassigned`;
  if($('adminOverviewUsers')) $('adminOverviewUsers').textContent=`${activeUsers} active ${activeUsers===1?'user':'users'}`;
  if($('adminOverviewCompanies')) $('adminOverviewCompanies').textContent=`${companies.length} ${companies.length===1?'company':'companies'}`;
  if($('adminOverviewActivities')) $('adminOverviewActivities').textContent=`${projectActs.length} activities • ${unassigned} unassigned`;
  if($('adminOverviewProject')){
    const p=projects.find(x=>x.id===selectedProjectId);
    $('adminOverviewProject').textContent=p?.project_name||'No project selected';
  }
}

let activeAdminTab='overview';
function setAdminTab(tab){
  const btn=[...document.querySelectorAll('.admin-tab')].find(b=>b.dataset.adminTab===tab && !b.classList.contains('hidden'));
  if(!btn) tab='overview';
  activeAdminTab=tab;
  document.querySelectorAll('.admin-tab').forEach(b=>b.classList.toggle('active',b.dataset.adminTab===tab));
  document.querySelectorAll('.admin-tab-panel').forEach(p=>p.classList.toggle('hidden',p.dataset.adminPanel!==tab));
  try{localStorage.setItem('adminActiveTab',tab);}catch(e){}
  if(tab==='activities') renderAdminActivities();
  if(tab==='users') renderUsers();
  updateAdminSummary();
}
function initAdminTabs(){
  document.querySelectorAll('.admin-tab').forEach(b=>b.addEventListener('click',()=>setAdminTab(b.dataset.adminTab)));
  document.querySelectorAll('[data-admin-tab-jump]').forEach(b=>b.addEventListener('click',()=>setAdminTab(b.dataset.adminTabJump)));
  $('adminHistoryShortcut')?.addEventListener('click',async()=>{
    document.querySelector('.nav-btn[data-view="history"]')?.click();
  });
  $('adminUserSearch')?.addEventListener('input',renderUsers);
  let saved='overview'; try{saved=localStorage.getItem('adminActiveTab')||'overview';}catch(e){}
  setAdminTab(saved);
}

function updateProjectLabel(){ const p=projects.find(x=>x.id===selectedProjectId); $('projectLabel').textContent=p?.project_name||'No project selected'; $('scheduleSubtitle').textContent=profile?.role==='sub' ? companyName(profile.company_id) : 'Live subcontractor updates'; updateAdminSummary(); }


$('projectSelect')?.addEventListener('change',async e=>{selectedProjectId=e.target.value;updateProjectLabel();await loadActivities();});
$('refreshBtn')?.addEventListener('click',async()=>{await loadReferenceData();await loadActivities();toast('Schedule refreshed');});

function isMeaningfulHistoryChange(h){
  if(!h) return false;
  const dateOrStatusChanged =
    h.old_start !== h.new_start ||
    h.old_finish !== h.new_finish ||
    h.old_status !== h.new_status ||
    h.old_percent !== h.new_percent;
  const hasComment = String(h.comment || '').trim().length > 0;
  return dateOrStatusChanged || hasComment;
}

async function loadSubChangedActivityIds(){
  subChangedActivityIds = new Set();
  if(!isGC() || !activities.length) return;
  const ids=activities.map(a=>a.id);
  const subUserIds=new Set(profiles.filter(p=>p.role==='sub').map(p=>p.id));
  if(!subUserIds.size) return;
  // Only mark activities with a meaningful audit record made by a subcontractor.
  const {data,error}=await sb.from('activity_history').select('*').in('activity_id',ids);
  if(error){ console.warn('Could not load subcontractor change history:',error.message); return; }
  (data||[]).forEach(h=>{
    if(subUserIds.has(h.changed_by) && isMeaningfulHistoryChange(h)) subChangedActivityIds.add(h.activity_id);
  });
}

async function loadActivities(){
  if(!selectedProjectId){ activities=[];subChangedActivityIds=new Set();renderActivities();return; }
  let q=sb.from('activities').select('*').eq('project_id',selectedProjectId).order('current_start',{ascending:true,nullsFirst:false});
  const {data,error}=await q;
  if(error){toast(error.message);return;}
  activities=data||[];
  await loadSubChangedActivityIds();
  renderActivities(); renderAdminActivities(); updateAdminSummary();
}

function effectiveScheduleStart(a){
  if(!a) return null;
  if(a.current_start) return a.current_start;
  // If only a current finish exists, derive the current start from the activity duration.
  if(a.current_finish){
    const derived=startFromFinishAndDuration(a.current_finish, baselineDuration(a));
    if(derived) return derived;
  }
  return a.original_start || null;
}
function effectiveScheduleFinish(a){
  if(!a) return null;
  if(a.current_finish) return a.current_finish;
  // If a current start exists but finish is blank, derive finish from current start + duration.
  // Do not mix a live current start with an older baseline finish.
  if(a.current_start){
    const derived=finishFromStartAndDuration(a.current_start, baselineDuration(a));
    if(derived) return derived;
    return a.current_start;
  }
  return a.original_finish || effectiveScheduleStart(a);
}
function scheduleDateValue(v){ return v ? new Date(v+'T12:00:00').getTime() : Number.POSITIVE_INFINITY; }
function chronologicalSort(a,b){
  const s=scheduleDateValue(effectiveScheduleStart(a))-scheduleDateValue(effectiveScheduleStart(b));
  if(s!==0) return s;
  const f=scheduleDateValue(effectiveScheduleFinish(a))-scheduleDateValue(effectiveScheduleFinish(b));
  if(f!==0) return f;
  return String(a.activity_code||'').localeCompare(String(b.activity_code||''),undefined,{numeric:true,sensitivity:'base'});
}
function filteredActivities(){
  const q=($('searchInput').value||'').toLowerCase(); const trade=$('tradeFilter')?.value||''; const status=$('statusFilter').value;
  const today=new Date(); today.setHours(0,0,0,0); let horizon=null;
  if(['4','6'].includes(currentRange)){ horizon=new Date(today); horizon.setDate(horizon.getDate()+(Number(currentRange)*7)); }
  const rows=activities.filter(a=>{
    if(currentRange==='all' && a.status==='Complete') return false;
    if(currentRange==='changed' && !subChangedActivityIds.has(a.id)) return false;
    if(horizon){
      // Use live/current dates when entered; otherwise fall back to the baseline schedule dates.
      const startValue=effectiveScheduleStart(a), finishValue=effectiveScheduleFinish(a);
      const s=startValue?new Date(startValue+'T12:00:00'):null;
      const f=finishValue?new Date(finishValue+'T12:00:00'):s;
      if(!s || !f) return false;

      // Keep overdue activities visible in both look-aheads when they have not started.
      // This lets the team see missed work whose effective scheduled start is before today,
      // even though it falls outside the normal forward-looking window.
      const overdueNotStarted = a.status === 'Not Started' && s < today;
      const inLookaheadWindow = s <= horizon && f >= today;
      if(!overdueNotStarted && !inLookaheadWindow) return false;
    }
    if(trade==='__unassigned' && a.company_id) return false;
    if(trade && trade!=='__unassigned' && a.company_id!==trade) return false;
    if(status && a.status!==status) return false;
    if(isSub() && subStatusFilter){
      const effStart=effectiveScheduleStart(a);
      const startDate=effStart?new Date(effStart+'T12:00:00'):null;
      if(subStatusFilter==='Past Due'){
        if(!(a.status==='Not Started' && startDate && startDate<today)) return false;
      } else if(a.status!==subStatusFilter) return false;
    }
    const hay=[a.activity_code,a.activity_name,a.area,companyName(a.company_id)].join(' ').toLowerCase();
    if(q && !hay.includes(q)) return false;
    return true;
  });
  // Look-aheads are always displayed in chronological order using current dates first,
  // with baseline dates as the fallback when current dates are blank.
  if(['4','6'].includes(currentRange)) rows.sort(chronologicalSort);
  return rows;
}
function isPastDueActivity(a){
  if(!a || a.status!=='Not Started') return false;
  const s=effectiveScheduleStart(a); if(!s) return false;
  const today=new Date(); today.setHours(0,0,0,0);
  return new Date(s+'T12:00:00') < today;
}
function reviewedRecently(a){
  if(!a?.last_reviewed_at) return false;
  const d=new Date(a.last_reviewed_at); if(isNaN(d)) return false;
  return (Date.now()-d.getTime()) <= 7*24*60*60*1000;
}
function renderSubDashboard(rows){
  const dash=$('subDashboard'), table=$('scheduleTableWrap');
  if(!dash || !table) return;
  dash.classList.toggle('hidden',!isSub());
  table.classList.toggle('hidden',isSub());
  $('stats')?.classList.toggle('hidden',isSub());
  $('scheduleTitle')?.classList.toggle('hidden',isSub());
  $('scheduleSubtitle')?.classList.toggle('hidden',isSub());
  if(!isSub()) return;

  const baseRows=activities.filter(a=>a.status!=='Complete');
  const lookRows=filteredActivities();
  const pastDue=lookRows.filter(isPastDueActivity).length;
  const progress=lookRows.filter(a=>a.status==='In Progress').length;
  const notStarted=lookRows.filter(a=>a.status==='Not Started').length;
  const reviewed=lookRows.filter(reviewedRecently).length;
  const name=(profile.full_name||'').split(' ')[0]||'there';
  $('subWelcome').textContent=`Welcome, ${name}!`;
  $('subReviewSummary').textContent="Here’s your 4-Week Look Ahead. Review each activity and update anything that has started or completed.";
  $('subReviewProgress').textContent=`${reviewed} of ${lookRows.length} reviewed`;
  $('subQuickStats').innerHTML=[['Total',lookRows.length,''],['Past Due',pastDue,'past'],['In Progress',progress,'progress'],['Not Started',notStarted,'']].map(([l,n,c])=>`<div class="sub-stat ${c}"><strong>${n}</strong><span>${l}</span></div>`).join('');

  $('subActivityCards').innerHTML=rows.map(a=>{
    const overdue=isPastDueActivity(a);
    const pct=effectivePercent(a);
    const review=reviewedRecently(a)?'<span class="reviewed-mark">✓ Reviewed</span>':'';
    const scope=a.scope_issue?'<span class="scope-flag">Not My Scope</span>':'';
    return `<button class="sub-activity-card ${overdue?'overdue':''} ${a.status==='In Progress'?'in-progress':''}" data-id="${a.id}" type="button">
      <div class="sub-card-main"><div class="sub-card-top"><strong>${esc(a.activity_name)}</strong>${overdue?'<span class="past-chip">Past Due</span>':a.status==='In Progress'?'<span class="progress-chip">In Progress</span>':`<span class="status-chip">${esc(a.status)}</span>`}</div>
      <div class="sub-card-meta">${esc(a.activity_code)}${a.area?' • '+esc(a.area):''}</div>
      <div class="sub-card-dates">${fmt(effectiveScheduleStart(a))} – ${fmt(effectiveScheduleFinish(a))}</div>
      <div class="sub-card-bottom"><span>${a.status==='In Progress'?pct+'% Complete':esc(a.status)}</span>${review}${scope}</div></div><span class="sub-card-arrow">›</span>
    </button>`;
  }).join('') || '<div class="card empty">No activities match this view.</div>';
  document.querySelectorAll('.sub-activity-card').forEach(b=>b.onclick=()=>openEdit(b.dataset.id));
}
function gcMobileAttentionRows(){
  return activities.filter(a=>a.status!=='Complete' && (isPastDueActivity(a) || a.scope_issue || ((a.status==='In Progress'||a.status==='Delayed') && !a.current_start) || (a.current_start&&a.original_start&&a.current_start!==a.original_start) || (a.current_finish&&a.original_finish&&a.current_finish!==a.original_finish)));
}
function gcMobileCardMarkup(a){
  const overdue=isPastDueActivity(a);
  const changed=(a.current_start&&a.original_start!==a.current_start)||(a.current_finish&&a.original_finish!==a.current_finish);
  const pct=effectivePercent(a);
  const tags=[overdue?'<span class="gc-tag danger">Past Due</span>':'',a.scope_issue?'<span class="gc-tag issue">Scope Flag</span>':'',changed?'<span class="gc-tag changed">Date Change</span>':'',a.status==='In Progress'?'<span class="gc-tag progress">In Progress</span>':''].filter(Boolean).join('');
  return `<button class="gc-activity-card ${overdue?'overdue':''}" type="button" data-id="${a.id}">
    <div class="gc-card-head"><div><strong>${esc(a.activity_name)}</strong><div class="gc-card-code">${esc(a.activity_code)}${a.area?' • '+esc(a.area):''}</div></div><span class="gc-card-arrow">›</span></div>
    <div class="gc-card-tags">${tags||`<span class="gc-tag">${esc(a.status)}</span>`}</div>
    <div class="gc-card-grid"><div><span>Trade</span><b>${esc(companyName(a.company_id))}</b></div><div><span>Duration</span><b>${baselineDuration(a)==null?'—':baselineDuration(a)+'d'}</b></div><div><span>Baseline</span><b>${fmt(a.original_start)} – ${fmt(a.original_finish)}</b></div><div><span>Current</span><b>${fmt(a.current_start)} – ${fmt(a.current_finish)}</b></div></div>
    <div class="gc-card-foot"><span>${esc(a.status)}${a.status==='In Progress'?' • '+pct+'%':''}</span><span>${a.last_reviewed_at?'Reviewed '+new Date(a.last_reviewed_at).toLocaleDateString():''}</span></div>
  </button>`;
}
function renderGCMobileDashboard(rows){
  const dash=$('gcMobileDashboard'), table=$('scheduleTableWrap');
  if(!dash||!table) return;
  const mobileGC=isGC();
  dash.classList.toggle('hidden',!mobileGC);
  if(!mobileGC) return;

  // The dashboard must reflect the exact same activity set produced by the
  // active range/search/trade/status filters.
  const baseRows=Array.isArray(rows)?rows:filteredActivities();
  const attention=baseRows.filter(a=>a.status!=='Complete' && (
    isPastDueActivity(a) ||
    a.scope_issue ||
    ((a.status==='In Progress'||a.status==='Delayed') && !a.current_start) ||
    (a.current_start&&a.original_start&&a.current_start!==a.original_start) ||
    (a.current_finish&&a.original_finish&&a.current_finish!==a.original_finish)
  ));
  const visible=gcMobileIssuesOnly ? attention.slice().sort(chronologicalSort) : baseRows;
  const remaining=baseRows.filter(a=>a.status!=='Complete').length;
  const pastDue=baseRows.filter(a=>a.status!=='Complete'&&isPastDueActivity(a)).length;
  const progress=baseRows.filter(a=>a.status==='In Progress').length;
  const changes=baseRows.filter(a=>(a.current_start&&a.original_start!==a.current_start)||(a.current_finish&&a.original_finish!==a.current_finish)).length;
  const scope=baseRows.filter(a=>a.scope_issue).length;
  const issues=baseRows.filter(a=>a.status!=='Complete' && (
    a.scope_issue ||
    (a.current_start&&a.original_start!==a.current_start) ||
    (a.current_finish&&a.original_finish!==a.current_finish)
  )).length;
  const label=currentRange==='4'?'4-Week Look Ahead':currentRange==='6'?'6-Week Look Ahead':currentRange==='changed'?'Changed Activities':'All Remaining';
  $('gcMobileSummaryText').textContent=label;
  $('gcMobileStats').innerHTML=[['Remaining',remaining,''],['Past Due',pastDue,'danger'],['In Progress',progress,'progress'],['Issues',issues,'issue']].map(([l,n,c])=>`<button type="button" class="gc-mobile-stat ${c}" data-gc-stat="${l}"><strong>${n}</strong><span>${l}</span></button>`).join('');
  const top=attention.slice().sort(chronologicalSort).slice(0,5);
  $('gcNeedsAttention').innerHTML=top.length?top.map(a=>`<button class="gc-attention-row" type="button" data-id="${a.id}"><div><strong>${esc(a.activity_code)} • ${esc(a.activity_name)}</strong><span>${esc(companyName(a.company_id))} • ${isPastDueActivity(a)?'Past Due':a.scope_issue?'Scope Flag':'Needs Review'}</span></div><b>›</b></button>`).join(''):'<div class="gc-attention-empty">Nothing needs attention right now.</div>';
  $('gcMobileResultCount').textContent=`${visible.length} activities`;
  $('gcActivityCards').innerHTML=visible.length?visible.map(gcMobileCardMarkup).join(''):'<div class="card empty">No activities match this view.</div>';
  document.querySelectorAll('.gc-activity-card,.gc-attention-row').forEach(b=>b.onclick=()=>{const a=activities.find(x=>x.id===b.dataset.id);if(a&&isActivityAdmin())openAdminActivity(a); else if(a) toast(`${a.activity_code}: ${a.activity_name}`);});
  document.querySelectorAll('.gc-mobile-stat').forEach(b=>b.onclick=()=>{
    if(b.dataset.gcStat==='Past Due'){ gcMobileIssuesOnly=true; renderGCMobileDashboard(baseRows.filter(a=>a.status!=='Complete'&&isPastDueActivity(a))); }
    else if(b.dataset.gcStat==='In Progress'){ gcMobileIssuesOnly=false; $('statusFilter').value='In Progress'; renderActivities(); }
    else if(b.dataset.gcStat==='Issues'){ gcMobileIssuesOnly=true; renderGCMobileDashboard(baseRows); }
  });
}

function renderActivities(){
  const rows=filteredActivities(); $('emptyState').classList.toggle('hidden',rows.length>0);
  renderSubDashboard(rows);
  renderGCMobileDashboard(rows);
  if(!isSub()){
    $('activityBody').innerHTML=rows.map(a=>{
      const startChanged=!!a.current_start && a.original_start!==a.current_start, finishChanged=!!a.current_finish && a.original_finish!==a.current_finish;
      return `<tr>
        <td class="gc-only ${!isGC()?'hidden':''}">${esc(companyName(a.company_id))}</td>
        <td><strong>${esc(a.activity_code)}</strong></td><td>${esc(a.area||'')}</td><td>${esc(a.activity_name)}${a.scope_issue?' <span class="scope-flag">Scope flagged</span>':''}</td>
        <td>${fmt(a.original_start)}</td><td>${baselineDuration(a)==null?'—':`${baselineDuration(a)}d`}</td><td>${fmt(a.original_finish)}</td>
        <td><span class="${startChanged?'changed-date':''}">${fmt(a.current_start)}</span></td><td><span class="${finishChanged?'changed-date':''}">${fmt(a.current_finish)}</span></td>
        <td><span class="status">${esc(a.status)}</span></td><td>${effectivePercent(a)}%</td>
        <td>${canUpdateActivity()?`<button class="ghost edit-act" data-id="${a.id}">${isActivityAdmin()?'Edit':'Update'}</button>`:'<span class="muted small">View only</span>'}</td></tr>`;
    }).join('');
    document.querySelectorAll('.edit-act').forEach(b=>b.onclick=()=>openEdit(b.dataset.id));
  }
  renderStats(rows);
}
function renderStats(rows=filteredActivities()){
  const today=isoDate(new Date());
  // Stats always reflect the activities currently visible under the active filters.
  const remaining=rows.filter(a=>a.status!=='Complete').length;
  const delayed=rows.filter(a=>a.status==='Delayed' || isPastDueActivity(a)).length;
  const changed=rows.filter(a=>(a.current_start&&a.original_start!==a.current_start)||(a.current_finish&&a.original_finish!==a.current_finish)).length;
  const progress=rows.filter(a=>a.status==='In Progress').length;
  $('stats').innerHTML=[['Remaining',remaining],['In Progress',progress],['Delayed / Past Due',delayed],['Date Changes',changed]].map(([l,n])=>`<div class="stat"><div class="num">${n}</div><div class="label">${l}</div></div>`).join('');
}

['searchInput','tradeFilter','statusFilter'].forEach(id=>$(id)?.addEventListener(id==='searchInput'?'input':'change',renderActivities));
document.querySelectorAll('.range-btn').forEach(b=>b.addEventListener('click',()=>{gcMobileIssuesOnly=false;document.querySelectorAll('.range-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');currentRange=b.dataset.range;renderActivities();}));
document.querySelectorAll('.sub-chip').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.sub-chip').forEach(x=>x.classList.remove('active'));b.classList.add('active');subStatusFilter=b.dataset.subStatus||'';renderActivities();}));

$('editStart')?.addEventListener('change', ()=>{ autoFillEditFinish(); refreshEditAutoPercent(); });
$('editFinish')?.addEventListener('change', ()=>{ autoFillEditStart(); refreshEditAutoPercent(); });
$('adminCurrentStart')?.addEventListener('change', ()=>{ autoFillAdminFinish(); refreshAdminAutoPercent(); });
$('adminCurrentFinish')?.addEventListener('change', ()=>{ autoFillAdminStart(); refreshAdminAutoPercent(); });
$('adminDuration')?.addEventListener('change', ()=>{
  if($('adminCurrentStart')?.value) autoFillAdminFinish();
  else if($('adminCurrentFinish')?.value) autoFillAdminStart();
  refreshAdminAutoPercent();
});
$('adminStatus')?.addEventListener('change', refreshAdminAutoPercent);
$('adminAutoPercent')?.addEventListener('change', refreshAdminAutoPercent);

function updateQuickStatusButtons(){
  const s=$('editStatus')?.value;
  document.querySelectorAll('.sub-status-btn').forEach(b=>b.classList.toggle('selected',b.dataset.quickStatus===s));
}
function openEdit(id){
  if(!canUpdateActivity()) return;
  const a=activities.find(x=>x.id===id); if(!a)return;
  if(isActivityAdmin()){ openAdminActivity(a); return; }
  $('editId').value=a.id;$('editTitle').textContent=a.activity_name;$('editCode').textContent=`${a.activity_code} • ${a.area||'No area'}`;
  $('baselineDates').textContent=`Start ${fmt(a.original_start)} • ${baselineDuration(a)==null?'—':baselineDuration(a)+' days'} • Finish ${fmt(a.original_finish)}`;$('editStart').value=a.current_start||'';$('editFinish').value=a.current_finish||'';$('editStatus').value=a.status;$('editNotes').value=a.notes||'';refreshEditAutoPercent();
  if($('editStart').value && !$('editFinish').value) autoFillEditFinish();
  else if(!$('editStart').value && $('editFinish').value) autoFillEditStart();
  const rows=filteredActivities(); const pos=rows.findIndex(x=>x.id===a.id); $('editPosition').textContent=pos>=0?`${pos+1} of ${rows.length}`:'';
  $('editPastDueBadge').classList.toggle('hidden',!isPastDueActivity(a));
  updateQuickStatusButtons();
  saveAndNextRequested=false;
  $('editModal').classList.remove('hidden');
}
function closeEditModal(){ $('editModal').classList.add('hidden'); }
$('closeModal')?.addEventListener('click',closeEditModal);
$('subBackBtn')?.addEventListener('click',closeEditModal);
$('editModal')?.addEventListener('click',e=>{if(e.target===$('editModal'))closeEditModal()});

document.querySelectorAll('.sub-status-btn').forEach(b=>b.addEventListener('click',()=>{
  const status=b.dataset.quickStatus;
  $('editStatus').value=status;
  if(status==='In Progress' && !$('editStart').value){ $('editStart').value=isoDate(new Date()); autoFillEditFinish(); }
  if(status==='Complete'){
    if(!$('editFinish').value) $('editFinish').value=isoDate(new Date());
    if(!$('editStart').value) autoFillEditStart();
  }
  refreshEditAutoPercent(); updateQuickStatusButtons();
}));
$('editStatus')?.addEventListener('change',()=>{refreshEditAutoPercent();updateQuickStatusButtons();});

async function patchReviewOnly(extra){
  const id=$('editId').value;
  const patch={last_reviewed_at:new Date().toISOString(),...extra};
  const {error}=await sb.from('activities').update(patch).eq('id',id);
  if(error){toast(error.message);return false;}
  await loadActivities(); return true;
}
$('notMyScopeBtn')?.addEventListener('click',async()=>{
  if(!confirm('Flag this activity as not belonging to your company?')) return;
  if(await patchReviewOnly({scope_issue:true})){toast('Flagged for GC review');closeEditModal();}
});
$('noChangesBtn')?.addEventListener('click',async()=>{
  if(await patchReviewOnly({last_reviewed_at:new Date().toISOString(),scope_issue:false})){toast('Marked reviewed');closeEditModal();}
});
$('saveNextBtn')?.addEventListener('click',()=>{saveAndNextRequested=true;});
$('editForm')?.addEventListener('submit',async e=>{
  e.preventDefault(); const id=$('editId').value;
  const visibleBefore=filteredActivities(); const idx=visibleBefore.findIndex(x=>x.id===id); const nextId=idx>=0&&idx<visibleBefore.length-1?visibleBefore[idx+1].id:null;
  const patch={current_start:$('editStart').value||null,current_finish:$('editFinish').value||null,status:$('editStatus').value,percent_complete:calculateSchedulePercent($('editStatus').value,$('editStart').value,baselineDuration(activities.find(x=>x.id===$('editId').value)),0,true,$('editFinish').value),notes:$('editNotes').value.trim()||null,last_reviewed_at:new Date().toISOString(),scope_issue:false};
  if(patch.current_start && patch.current_finish && patch.current_finish<patch.current_start){toast('Finish date cannot be before start date');return;}
  const {error}=await sb.from('activities').update(patch).eq('id',id); if(error){toast(error.message);return;}
  closeEditModal();toast('Activity updated');await loadActivities();
  if(saveAndNextRequested && nextId && activities.some(a=>a.id===nextId)) setTimeout(()=>openEdit(nextId),120);
  saveAndNextRequested=false;
});

$('gcNeedsAttentionBtn')?.addEventListener('click',()=>{gcMobileIssuesOnly=true;renderGCMobileDashboard(gcMobileAttentionRows().slice().sort(chronologicalSort));});
$('gcMobileRefresh')?.addEventListener('click',async()=>{await loadActivities();toast('Schedule refreshed');});

document.querySelectorAll('.gc-mobile-nav-btn').forEach(b=>b.addEventListener('click',async()=>{
  document.querySelectorAll('.gc-mobile-nav-btn').forEach(x=>x.classList.remove('active')); b.classList.add('active');
  const view=b.dataset.mobileView;
  if(view==='issues'){
    document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden')); $('scheduleView').classList.remove('hidden');
    gcMobileIssuesOnly=true; renderGCMobileDashboard(gcMobileAttentionRows().slice().sort(chronologicalSort));
    return;
  }
  gcMobileIssuesOnly=false;
  document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));
  const el=$(view+'View'); if(el) el.classList.remove('hidden');
  if(view==='history') await loadHistory();
  if(view==='admin') await loadReferenceData();
  if(view==='schedule') renderActivities();
}));

// Navigation
document.querySelectorAll('.nav-btn').forEach(b=>b.addEventListener('click',async()=>{
  document.querySelectorAll('.nav-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');
  document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));$(b.dataset.view+'View').classList.remove('hidden');
  if(b.dataset.view==='history') await loadHistory();
  if(b.dataset.view==='admin') await loadReferenceData();
}));

async function loadHistory(){
  if(!selectedProjectId)return;
  const ids=activities.map(a=>a.id); if(!ids.length){$('historyBody').innerHTML='';return;}
  const subUserIds=new Set(profiles.filter(p=>p.role==='sub').map(p=>p.id));
  if(!subUserIds.size){$('historyBody').innerHTML='';return;}
  const {data,error}=await sb.from('activity_history').select('*').in('activity_id',ids).order('changed_at',{ascending:false}).limit(500);
  if(error){toast(error.message);return;}
  const rows=(data||[]).filter(h=>subUserIds.has(h.changed_by) && isMeaningfulHistoryChange(h)).slice(0,250);
  $('historyBody').innerHTML=rows.map(h=>{const a=activities.find(x=>x.id===h.activity_id);return `<tr><td>${new Date(h.changed_at).toLocaleString()}</td><td>${esc(a?.activity_code||'')}</td><td>${esc(profileName(h.changed_by))}</td><td>${fmt(h.old_start)} → ${fmt(h.new_start)}</td><td>${fmt(h.old_finish)} → ${fmt(h.new_finish)}</td><td>${esc(h.old_status||'')} → ${esc(h.new_status||'')}</td><td>${esc(h.comment||'')}</td></tr>`}).join('');
}

$('projectForm')?.addEventListener('submit',async e=>{e.preventDefault();const name=$('newProjectName').value.trim();if(!name)return;const {error}=await sb.from('projects').insert({project_name:name});if(error){toast(error.message);return;}$('newProjectName').value='';toast('Project added');await loadReferenceData();});
$('companyForm')?.addEventListener('submit',async e=>{e.preventDefault();const company_name=$('newCompanyName').value.trim();const trade=$('newTradeName').value.trim()||null;if(!company_name)return;const {error}=await sb.from('companies').insert({company_name,trade});if(error){toast(error.message);return;}$('newCompanyName').value='';$('newTradeName').value='';toast('Company added');await loadReferenceData();});

$('emailForemenBtn')?.addEventListener('click', async ()=>{
  if(!isAdmin()) return;
  const recipients=profiles.filter(p=>p.role==='sub' && p.active && p.email);
  if(!recipients.length){toast('No active subcontractor users with email addresses');return;}
  const names=recipients.map(p=>`${p.full_name||p.email} (${companyName(p.company_id)})`).join('\n');
  if(!confirm(`Send the 4-Week Look Ahead update request to ${recipients.length} active subcontractor user${recipients.length===1?'':'s'}?\n\n${names}`)) return;

  const btn=$('emailForemenBtn'), status=$('emailForemenStatus');
  if(btn){btn.disabled=true;btn.textContent='Sending…';}
  if(status) status.textContent='Sending update request…';
  try{
    const r=await fetch('/api/admin/email-foremen',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},
      body:'{}'
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok){
      toast(data.error||'Could not send email');
      if(status) status.textContent=data.error||'Could not send email.';
      return;
    }
    const msg=`Sent to ${data.sent_count} foremen${data.failed_count?`; ${data.failed_count} failed`:''}.`;
    toast(msg);
    if(status) status.textContent=msg;
  }finally{
    if(btn){btn.disabled=false;btn.textContent='Email Active Foremen';}
  }
});

$('userRole')?.addEventListener('change',e=>{$('userCompany').disabled=e.target.value!=='sub'; if(e.target.value!=='sub')$('userCompany').value='';});
$('userForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const payload={full_name:$('userName').value.trim(),email:$('userEmail').value.trim(),password:$('userPassword').value,role:$('userRole').value,company_id:$('userCompany').value||null};
  const r=await fetch('/api/admin/create-user',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},body:JSON.stringify(payload)});const data=await r.json();if(!r.ok){toast(data.error||'Could not create user');return;}
  e.target.reset();toast('User created');await loadReferenceData();
});
async function toggleUser(id,active){const r=await fetch(`/api/admin/user/${id}/active`,{method:'PATCH',headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},body:JSON.stringify({active})});const data=await r.json();if(!r.ok){toast(data.error||'Could not update user');return;}toast(active?'User activated':'User deactivated');await loadReferenceData();}

async function deleteUser(id){
  const u=profiles.find(p=>p.id===id);
  if(!u) return;
  const label=u.full_name||u.email||'this user';
  if(!confirm(`Permanently delete ${label}?\n\nThis removes their login and user profile and cannot be undone.`)) return;
  const r=await fetch(`/api/admin/user/${id}`,{
    method:'DELETE',
    headers:{'Authorization':`Bearer ${session.access_token}`}
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok){toast(data.error||'Could not delete user');return;}
  toast('User deleted');
  await loadReferenceData();
}

function openPasswordModal(userId){
  if(!isAdmin()) return;
  const p=profiles.find(x=>x.id===userId); if(!p) return;
  $('passwordUserId').value=userId;
  $('passwordUserLabel').textContent=`${p.full_name||p.email} • ${p.email||''}`;
  $('newUserPassword').value='';
  $('confirmUserPassword').value='';
  $('passwordModal').classList.remove('hidden');
  setTimeout(()=>$('newUserPassword')?.focus(),50);
}
$('closePasswordModal')?.addEventListener('click',()=>$('passwordModal').classList.add('hidden'));
$('passwordModal')?.addEventListener('click',e=>{if(e.target===$('passwordModal'))$('passwordModal').classList.add('hidden')});
$('passwordForm')?.addEventListener('submit',async e=>{
  e.preventDefault(); if(!isAdmin()) return;
  const id=$('passwordUserId').value;
  const password=$('newUserPassword').value;
  const confirm=$('confirmUserPassword').value;
  if(password.length<8){toast('Password must be at least 8 characters');return;}
  if(password!==confirm){toast('Passwords do not match');return;}
  const r=await fetch(`/api/admin/user/${id}/password`,{method:'PATCH',headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},body:JSON.stringify({password})});
  const data=await r.json();
  if(!r.ok){toast(data.error||'Could not update password');return;}
  $('passwordModal').classList.add('hidden');
  toast('Password updated');
});

const collapsedAdminAreas = new Set();
function adminAreaNames(){
  return [...new Set(activities.map(adminAreaLabel))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
}
function collapseAllAdminAreas(){
  adminAreaNames().forEach(area=>collapsedAdminAreas.add(area));
  renderAdminActivities();
}
function expandAllAdminAreas(){
  collapsedAdminAreas.clear();
  renderAdminActivities();
}
function adminAreaLabel(a){
  if(a.area && String(a.area).trim()) return String(a.area).trim();
  const name=String(a.activity_name||'').trim();
  const m=name.match(/^\*{0,2}\s*(MU|FP|GL|EV|SD|A[1-9]|F)(?:\s*[-–—]|\s|$)/i);
  return m ? m[1].toUpperCase() : 'Other / No Area';
}
function populateAdminActivityFilters(){
  if($('adminActivityAreaFilter')){
    const current=$('adminActivityAreaFilter').value;
    $('adminActivityAreaFilter').innerHTML='<option value="">All Areas</option>'+adminAreaNames().map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join('');
    $('adminActivityAreaFilter').value=current;
  }
  if($('adminActivityTradeFilter')){
    const current=$('adminActivityTradeFilter').value;
    $('adminActivityTradeFilter').innerHTML='<option value="">All Trades</option>'+companies.map(c=>`<option value="${c.id}">${esc(c.company_name)}</option>`).join('')+'<option value="__unassigned">Unassigned / GC</option>';
    $('adminActivityTradeFilter').value=current;
  }
}
function filteredAdminActivities(){
  const q=String($('adminActivitySearch')?.value||'').trim().toLowerCase();
  const area=$('adminActivityAreaFilter')?.value||'';
  const trade=$('adminActivityTradeFilter')?.value||'';
  const status=$('adminActivityStatusFilter')?.value||'';
  return activities.filter(a=>{
    if(q && !`${a.activity_code||''} ${a.activity_name||''}`.toLowerCase().includes(q)) return false;
    if(area && adminAreaLabel(a)!==area) return false;
    if(trade==='__unassigned' && a.company_id) return false;
    if(trade && trade!=='__unassigned' && a.company_id!==trade) return false;
    if(status && a.status!==status) return false;
    return true;
  });
}
function renderAdminActivities(){
  if(!isActivityAdmin() || !$('adminActivityBody')) return;
  populateAdminActivityFilters();
  const shown=filteredAdminActivities();
  if($('adminActivityResultCount')) $('adminActivityResultCount').textContent=`${shown.length} ${shown.length===1?'activity':'activities'} shown`;
  const grouped={};
  shown.forEach(a=>{
    const area=adminAreaLabel(a);
    (grouped[area] ||= []).push(a);
  });
  const orderedAreas=Object.keys(grouped).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
  if(!orderedAreas.length){
    $('adminActivityBody').innerHTML='<tr><td colspan="7" class="muted">No activities match these filters.</td></tr>';
    return;
  }
  $('adminActivityBody').innerHTML=orderedAreas.map((area,idx)=>{
    const key=encodeURIComponent(area);
    const collapsed=collapsedAdminAreas.has(area);
    const rows=grouped[area].map(a=>`<tr class="admin-area-item ${collapsed?'hidden':''}" data-admin-area="${key}">
      <td>${esc(a.activity_code)}</td><td>${esc(a.activity_name)}</td><td>${esc(companyName(a.company_id))}</td>
      <td>${esc(a.area||adminAreaLabel(a))}</td><td>${fmt(a.original_start)}</td><td>${fmt(a.original_finish)}</td>
      <td><button class="ghost admin-edit-act" data-id="${a.id}">Edit</button> <button class="danger admin-delete-act" data-id="${a.id}">Delete</button></td>
    </tr>`).join('');
    return `<tr class="admin-area-header"><td colspan="7"><button class="admin-area-toggle" type="button" data-area-index="${idx}" aria-expanded="${!collapsed}"><span class="admin-area-arrow">${collapsed?'▶':'▼'}</span><span>${esc(area)}</span><span class="admin-area-count">${grouped[area].length} ${grouped[area].length===1?'activity':'activities'}</span></button></td></tr>${rows}`;
  }).join('');
  document.querySelectorAll('.admin-area-toggle').forEach(b=>b.onclick=()=>{
    const area=orderedAreas[Number(b.dataset.areaIndex)];
    if(collapsedAdminAreas.has(area)) collapsedAdminAreas.delete(area); else collapsedAdminAreas.add(area);
    renderAdminActivities();
  });
  document.querySelectorAll('.admin-edit-act').forEach(b=>b.onclick=()=>{const a=activities.find(x=>x.id===b.dataset.id);if(a)openAdminActivity(a);});
  document.querySelectorAll('.admin-delete-act').forEach(b=>b.onclick=()=>deleteActivity(b.dataset.id));
}
['adminActivitySearch','adminActivityAreaFilter','adminActivityTradeFilter','adminActivityStatusFilter'].forEach(id=>$(id)?.addEventListener(id==='adminActivitySearch'?'input':'change',renderAdminActivities));
$('clearAdminActivityFilters')?.addEventListener('click',()=>{
  ['adminActivitySearch','adminActivityAreaFilter','adminActivityTradeFilter','adminActivityStatusFilter'].forEach(id=>{if($(id)) $(id).value='';});
  renderAdminActivities();
});
$('collapseAllAreasBtn')?.addEventListener('click',collapseAllAdminAreas);
$('expandAllAreasBtn')?.addEventListener('click',expandAllAdminAreas);
initCompaniesTradesCollapse();
initAdminTabs();
function populateAdminCompanySelect(selected=''){
  if(!$('adminActivityCompany')) return;
  $('adminActivityCompany').innerHTML='<option value="">Unassigned / GC</option>'+companies.map(c=>`<option value="${c.id}">${esc(c.company_name)}</option>`).join('');
  $('adminActivityCompany').value=selected||'';
}
function openAdminActivity(a=null){
  if(!isActivityAdmin()) return;
  $('adminActivityId').value=a?.id||'';
  $('adminActivityModalTitle').textContent=a?'Edit Activity':'Add Activity';
  $('adminActivityCode').value=a?.activity_code||'';
  $('adminActivityName').value=a?.activity_name||'';
  $('adminActivityArea').value=a?.area||'';
  populateAdminCompanySelect(a?.company_id||'');
  $('adminBaselineStart').value=a?.original_start||'';
  $('adminBaselineFinish').value=a?.original_finish||'';
  $('adminCurrentStart').value=a?.current_start||'';
  $('adminCurrentFinish').value=a?.current_finish||'';
  $('adminDuration').value=a ? (baselineDuration(a)??'') : '';
  $('adminStatus').value=a?.status||'Not Started';
  $('adminAutoPercent').checked=a?.auto_percent!==false;
  $('adminPercent').value=a ? effectivePercent(a) : 0;
  $('adminNotes').value=a?.notes||'';
  if($('adminCurrentStart').value && !$('adminCurrentFinish').value) autoFillAdminFinish();
  else if(!$('adminCurrentStart').value && $('adminCurrentFinish').value) autoFillAdminStart();
  refreshAdminAutoPercent();
  $('adminActivityModal').classList.remove('hidden');
}
$('addActivityBtn')?.addEventListener('click',()=>openAdminActivity());
$('closeAdminActivityModal')?.addEventListener('click',()=>$('adminActivityModal').classList.add('hidden'));
$('adminActivityModal')?.addEventListener('click',e=>{if(e.target===$('adminActivityModal'))$('adminActivityModal').classList.add('hidden')});
$('adminActivityForm')?.addEventListener('submit',async e=>{
  e.preventDefault(); if(!isActivityAdmin())return;
  if(!selectedProjectId){toast('Select a project first');return;}
  const id=$('adminActivityId').value;
  const payload={
    project_id:selectedProjectId,
    activity_code:$('adminActivityCode').value.trim(),
    activity_name:$('adminActivityName').value.trim(),
    company_id:$('adminActivityCompany').value||null,
    area:$('adminActivityArea').value.trim()||null,
    original_start:$('adminBaselineStart').value||null,
    original_finish:$('adminBaselineFinish').value||null,
    current_start:$('adminCurrentStart').value||null,
    current_finish:$('adminCurrentFinish').value||null,
    duration_days:$('adminDuration').value===''?null:Number($('adminDuration').value),
    status:$('adminStatus').value,
    auto_percent:$('adminAutoPercent').checked,
    percent_complete:effectivePercentFromForm({status:$('adminStatus').value,start:$('adminCurrentStart').value,finish:$('adminCurrentFinish').value,duration:$('adminDuration').value,stored:$('adminPercent').value,auto:$('adminAutoPercent').checked}),
    notes:$('adminNotes').value.trim()||null,
  };
  if(!payload.activity_code||!payload.activity_name){toast('Activity ID and Activity Name are required');return;}
  if(payload.current_start&&payload.current_finish&&payload.current_finish<payload.current_start){toast('Current finish cannot be before current start');return;}
  if(payload.original_start&&payload.original_finish&&payload.original_finish<payload.original_start){toast('Baseline finish cannot be before baseline start');return;}
  let error;
  if(id){({error}=await sb.from('activities').update(payload).eq('id',id));}
  else {({error}=await sb.from('activities').insert(payload));}
  if(error){toast(error.message);return;}
  $('adminActivityModal').classList.add('hidden'); toast(id?'Activity saved':'Activity added'); await loadActivities(); renderAdminActivities();
});
async function deleteActivity(id){
  if(!isActivityAdmin())return;
  const a=activities.find(x=>x.id===id); if(!a)return;
  if(!confirm(`Delete ${a.activity_code} - ${a.activity_name}? This cannot be undone.`))return;
  const {error}=await sb.from('activities').delete().eq('id',id); if(error){toast(error.message);return;}
  toast('Activity deleted'); await loadActivities(); renderAdminActivities();
}

function normalizedRow(row){ const out={}; Object.entries(row).forEach(([k,v])=>out[String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_')]=v); return out; }
function pick(o,keys){for(const k of keys){if(o[k]!==undefined && o[k]!==null && String(o[k]).trim()!=='')return o[k];}return null;}
function excelDate(v){
  if(v===null||v===undefined||v==='')return null;
  if(typeof v==='number'){const d=XLSX.SSF.parse_date_code(v);if(d)return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;}
  const d=new Date(v);if(!isNaN(d))return isoDate(d);
  return null;
}
async function ensureCompany(name){
  if(!name)return null; const clean=String(name).trim(); let c=companies.find(x=>x.company_name.toLowerCase()===clean.toLowerCase()); if(c)return c.id;
  const {data,error}=await sb.from('companies').insert({company_name:clean}).select().single(); if(error)throw error; companies.push(data); return data.id;
}

$('uploadBtn')?.addEventListener('click',async()=>{
  const file=$('scheduleFile').files[0];if(!file){toast('Choose an Excel or CSV file first');return;}if(!selectedProjectId){toast('Create/select a project first');return;}
  $('uploadBtn').disabled=true;$('uploadResult').textContent='Reading schedule...';
  try{
    const buf=await file.arrayBuffer(); const wb=XLSX.read(buf,{type:'array',cellDates:false}); const ws=wb.Sheets[wb.SheetNames[0]]; const raw=XLSX.utils.sheet_to_json(ws,{defval:null});
    let imported=0,skipped=0; const batch=[];
    for(const rr of raw){
      const r=normalizedRow(rr);
      const code=pick(r,['activity_id','activity_code','id','activity']);
      const name=pick(r,['activity_name','activity_description','description','name']);
      if(!code||!name){skipped++;continue;}
      const companyLabel=pick(r,['trade_company','company_trade','company','subcontractor','trade','responsible_contractor']);
      const company_id=await ensureCompany(companyLabel);
      const start=excelDate(pick(r,['baseline_start','original_start','start','start_date']));
      const finish=excelDate(pick(r,['baseline_finish','original_finish','finish','finish_date']));
      const currentStart=excelDate(pick(r,['current_start']));
      const currentFinish=excelDate(pick(r,['current_finish']));
      const durationRaw=pick(r,['baseline_duration','planned_duration','pd','duration_workdays','duration','duration_days','remaining_duration']);
      let duration=durationRaw===null?null:(parseInt(String(durationRaw).replace(/[^0-9-]/g,''),10)||null);
      if(duration===null) duration=baselineWorkdays(start,finish);
      batch.push({project_id:selectedProjectId,company_id,activity_code:String(code).trim(),activity_name:String(name).trim(),area:String(pick(r,['area','location','building_area'])||'').trim()||null,original_start:start,original_finish:finish,current_start:currentStart,current_finish:currentFinish,duration_days:duration,status:'Not Started',percent_complete:0,auto_percent:true,source_upload:file.name});
    }
    for(let i=0;i<batch.length;i+=200){
      const part=batch.slice(i,i+200); const {error}=await sb.from('activities').upsert(part,{onConflict:'project_id,activity_code',ignoreDuplicates:true}); if(error)throw error; imported+=part.length;
      $('uploadResult').textContent=`Imported ${Math.min(imported,batch.length)} of ${batch.length}...`;
    }
    const {error:logErr}=await sb.from('schedule_uploads').insert({project_id:selectedProjectId,filename:file.name,rows_imported:imported,uploaded_by:session.user.id}); if(logErr)console.warn(logErr);
    await loadReferenceData();await loadActivities();$('uploadResult').textContent=`Done: ${imported} activities imported; ${skipped} rows skipped.`;toast('Schedule import complete');
  }catch(err){console.error(err);$('uploadResult').textContent=`Import error: ${err.message||err}`;toast('Schedule import failed');}
  finally{$('uploadBtn').disabled=false;}
});

init();

// V18: installable app / PWA support for Android and iPhone.
let deferredInstallPrompt = null;
function isStandaloneApp(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOSDevice(){
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}
function refreshInstallButtons(){
  const show = !isStandaloneApp() && (deferredInstallPrompt || isIOSDevice());
  document.querySelectorAll('.install-app-btn').forEach(btn => btn.classList.toggle('hidden', !show));
}
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  refreshInstallButtons();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  refreshInstallButtons();
  try{ toast('Trade Schedule installed'); }catch(_e){}
});
document.addEventListener('click', async e => {
  const btn=e.target.closest('.install-app-btn');
  if(!btn) return;
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(()=>null);
    deferredInstallPrompt=null;
    refreshInstallButtons();
    return;
  }
  if(isIOSDevice()){
    alert('To install on iPhone/iPad: open this page in Safari, tap the Share button, then choose “Add to Home Screen” and tap Add.');
    return;
  }
  alert('Open your browser menu and choose “Install app” or “Add to Home screen.”');
});
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(err=>console.warn('Service worker registration failed',err)));
}
refreshInstallButtons();

// V27 mobile calendar popup with Clear inside the calendar.
// Native mobile date pickers cannot be customized, so Current Start/Finish use
// this lightweight in-app calendar on phones while desktop keeps the native picker.
(function setupMobilePopupCalendar(){
  const mobileQuery=window.matchMedia('(max-width: 900px), (pointer: coarse)');
  const targetIds=new Set(['editStart','editFinish','adminCurrentStart','adminCurrentFinish']);
  let activeInput=null;
  let pendingValue='';
  let viewDate=new Date();

  const pad=n=>String(n).padStart(2,'0');
  const toIso=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const fromIso=v=>{
    if(!v) return null;
    const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if(!m) return null;
    const d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),12);
    return isNaN(d)?null:d;
  };

  const overlay=document.createElement('div');
  overlay.className='app-calendar-overlay hidden';
  overlay.innerHTML=`
    <div class="app-calendar" role="dialog" aria-modal="true" aria-label="Choose date">
      <div class="app-calendar-head">
        <button type="button" class="app-cal-nav" data-cal-action="prev" aria-label="Previous month">‹</button>
        <strong class="app-cal-title"></strong>
        <button type="button" class="app-cal-nav" data-cal-action="next" aria-label="Next month">›</button>
      </div>
      <div class="app-cal-weekdays"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
      <div class="app-cal-days"></div>
      <div class="app-cal-actions">
        <button type="button" class="app-cal-clear" data-cal-action="clear">Clear</button>
        <button type="button" class="app-cal-secondary" data-cal-action="cancel">Cancel</button>
        <button type="button" class="primary" data-cal-action="ok">OK</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const title=overlay.querySelector('.app-cal-title');
  const days=overlay.querySelector('.app-cal-days');

  function dispatchDateChange(input){
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    if(input.id==='editStart' || input.id==='editFinish') refreshEditAutoPercent();
    if(input.id==='adminCurrentStart' || input.id==='adminCurrentFinish') refreshAdminAutoPercent();
  }
  function renderCalendar(){
    const y=viewDate.getFullYear(), m=viewDate.getMonth();
    title.textContent=viewDate.toLocaleDateString(undefined,{month:'long',year:'numeric'});
    days.innerHTML='';
    const first=new Date(y,m,1,12);
    const lastDay=new Date(y,m+1,0,12).getDate();
    const selected=fromIso(pendingValue);
    const today=new Date();
    for(let i=0;i<first.getDay();i++){
      const blank=document.createElement('span'); blank.className='app-cal-blank'; days.appendChild(blank);
    }
    for(let d=1;d<=lastDay;d++){
      const date=new Date(y,m,d,12);
      const b=document.createElement('button');
      b.type='button'; b.className='app-cal-day'; b.textContent=d; b.dataset.date=toIso(date);
      if(selected && selected.getFullYear()===y && selected.getMonth()===m && selected.getDate()===d) b.classList.add('selected');
      if(today.getFullYear()===y && today.getMonth()===m && today.getDate()===d) b.classList.add('today');
      days.appendChild(b);
    }
  }
  function openCalendar(input){
    activeInput=input;
    pendingValue=input.value || '';
    const chosen=fromIso(pendingValue);
    viewDate=chosen || new Date();
    viewDate=new Date(viewDate.getFullYear(),viewDate.getMonth(),1,12);
    renderCalendar();
    overlay.classList.remove('hidden');
    document.body.classList.add('calendar-open');
  }
  function closeCalendar(){
    overlay.classList.add('hidden');
    document.body.classList.remove('calendar-open');
    activeInput=null;
    pendingValue='';
  }
  function syncReadonly(){
    document.querySelectorAll('input[data-popup-calendar]').forEach(input=>{
      if(mobileQuery.matches){
        // Force our in-app calendar on touch/mobile devices. Some mobile browsers
        // still open the native picker for readonly type=date inputs.
        if(!input.dataset.originalType) input.dataset.originalType=input.type || 'date';
        input.type='text';
        input.readOnly=true;
        input.inputMode='none';
        input.setAttribute('aria-haspopup','dialog');
        input.classList.add('popup-calendar-input');
      }else{
        input.type=input.dataset.originalType || 'date';
        input.readOnly=false;
        input.removeAttribute('inputmode');
        input.removeAttribute('aria-haspopup');
        input.classList.remove('popup-calendar-input');
      }
    });
  }
  syncReadonly();
  mobileQuery.addEventListener?.('change',syncReadonly);

  document.addEventListener('pointerdown',e=>{
    const input=e.target.closest('input[data-popup-calendar]');
    if(input && mobileQuery.matches && targetIds.has(input.id)){
      e.preventDefault();
    }
  },true);

  document.addEventListener('click',e=>{
    const input=e.target.closest('input[data-popup-calendar]');
    if(input && mobileQuery.matches && targetIds.has(input.id)){
      e.preventDefault();
      openCalendar(input);
      return;
    }
    const day=e.target.closest('.app-cal-day');
    if(day && activeInput){
      pendingValue=day.dataset.date;
      renderCalendar();
      return;
    }
    const action=e.target.closest('[data-cal-action]');
    if(!action) return;
    const kind=action.dataset.calAction;
    if(kind==='prev'){ viewDate=new Date(viewDate.getFullYear(),viewDate.getMonth()-1,1,12); renderCalendar(); }
    else if(kind==='next'){ viewDate=new Date(viewDate.getFullYear(),viewDate.getMonth()+1,1,12); renderCalendar(); }
    else if(kind==='clear' && activeInput){ activeInput.value=''; dispatchDateChange(activeInput); closeCalendar(); }
    else if(kind==='cancel'){ closeCalendar(); }
    else if(kind==='ok' && activeInput){ activeInput.value=pendingValue; dispatchDateChange(activeInput); closeCalendar(); }
  });
  overlay.addEventListener('click',e=>{ if(e.target===overlay) closeCalendar(); });
})();

// V34 - Look-ahead PDF export
function workdayVarianceDays(baselineFinish, currentFinish){
  if(!baselineFinish || !currentFinish) return null;
  const b=new Date(baselineFinish+'T12:00:00');
  const c=new Date(currentFinish+'T12:00:00');
  if(isNaN(b)||isNaN(c)) return null;
  if(b.getTime()===c.getTime()) return 0;
  const dir=c>b?1:-1;
  let n=0;
  const d=new Date(b);
  while((dir>0 && d<c) || (dir<0 && d>c)){
    d.setDate(d.getDate()+dir);
    const day=d.getDay();
    if(day!==0 && day!==6) n+=dir;
  }
  return n;
}
function lookaheadExportRows(rangeWeeks, tradeId=''){
  const today=new Date(); today.setHours(0,0,0,0);
  const horizon=new Date(today); horizon.setDate(horizon.getDate()+(Number(rangeWeeks)*7));
  return activities.filter(a=>{
    if(isSub() && a.company_id!==profile.company_id) return false;
    if(tradeId && a.company_id!==tradeId) return false;
    const startValue=effectiveScheduleStart(a), finishValue=effectiveScheduleFinish(a);
    const s=startValue?new Date(startValue+'T12:00:00'):null;
    const f=finishValue?new Date(finishValue+'T12:00:00'):s;
    if(!s || !f) return false;
    const overdueNotStarted=a.status==='Not Started' && s<today;
    const inWindow=s<=horizon && f>=today;
    return overdueNotStarted || inWindow;
  }).sort((a,b)=>{
    if(!tradeId && !isSub()){
      const tc=companyName(a.company_id).localeCompare(companyName(b.company_id),undefined,{sensitivity:'base'});
      if(tc!==0) return tc;
    }
    return chronologicalSort(a,b);
  });
}
function openLookaheadExport(){
  const modal=$('exportLookaheadModal'); if(!modal) return;
  const trade=$('exportTrade');
  if(trade){
    const sorted=[...companies].sort((a,b)=>String(a.company_name||'').localeCompare(String(b.company_name||'')));
    trade.innerHTML='<option value="">All Trades</option>'+sorted.map(c=>`<option value="${c.id}">${esc(c.company_name)}</option>`).join('');
    if(isSub()){
      trade.value=profile.company_id||'';
      trade.disabled=true;
      $('exportTradeLabel')?.classList.add('hidden');
    }else{
      trade.disabled=false;
      $('exportTradeLabel')?.classList.remove('hidden');
      const activeTrade=$('tradeFilter')?.value||'';
      if(activeTrade) trade.value=activeTrade;
    }
  }
  const activeRange=['4','6'].includes(currentRange)?currentRange:'4';
  if($('exportRange')) $('exportRange').value=activeRange;
  modal.classList.remove('hidden');
}
function closeLookaheadExport(){ $('exportLookaheadModal')?.classList.add('hidden'); }
$('exportLookaheadBtn')?.addEventListener('click',openLookaheadExport);
$('closeExportLookaheadModal')?.addEventListener('click',closeLookaheadExport);
$('exportLookaheadModal')?.addEventListener('click',e=>{ if(e.target?.id==='exportLookaheadModal') closeLookaheadExport(); });
$('exportLookaheadForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const btn=$('generateLookaheadPdfBtn');
  const range=$('exportRange')?.value||'4';
  const tradeId=isSub()?profile.company_id:($('exportTrade')?.value||'');
  const rows=lookaheadExportRows(range,tradeId);
  if(!rows.length){ toast('No activities found for this look-ahead'); return; }
  const project=projects.find(p=>p.id===selectedProjectId);
  const tradeName=tradeId?companyName(tradeId):'All Trades';
  const payload={
    project_name:project?.project_name||'CTCC Oasis',
    range_weeks:Number(range),
    trade_name:tradeName,
    rows:rows.map(a=>{
      const variance=workdayVarianceDays(a.original_finish,a.current_finish);
      return {
        trade:companyName(a.company_id),
        activity_code:a.activity_code||'',
        area:a.area||'',
        activity_name:a.activity_name||'',
        baseline_start:a.original_start||'',
        baseline_finish:a.original_finish||'',
        current_start:a.current_start||'',
        current_finish:a.current_finish||'',
        status:a.status||'',
        percent:effectivePercent(a),
        variance_days:variance,
        notes:a.notes||''
      };
    })
  };
  try{
    if(btn){btn.disabled=true;btn.textContent='Generating...';}
    const token=session?.access_token;
    const r=await fetch('/api/export/lookahead-pdf',{
      method:'POST',
      headers:{'Content-Type':'application/json',...(token?{'Authorization':`Bearer ${token}`}:{})},
      body:JSON.stringify(payload)
    });
    if(!r.ok){
      let msg='Could not generate PDF';
      try{const d=await r.json();msg=d.error||msg;}catch(_){ }
      throw new Error(msg);
    }
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    const safeTrade=tradeName.replace(/[^A-Za-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'')||'All_Trades';
    a.href=url;a.download=`${range}-Week_Lookahead_${safeTrade}.pdf`;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
    closeLookaheadExport();
    toast('Look-ahead PDF downloaded');
  }catch(err){ toast(err.message||'Could not generate PDF'); }
  finally{ if(btn){btn.disabled=false;btn.textContent='Generate PDF';} }
});
