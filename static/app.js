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
const esc = (s='') => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function toast(msg){ const el=$('toast'); el.textContent=msg; el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'),2600); }
function isGC(){ return profile && ['gc','gc_admin'].includes(profile.role); }
function isAdmin(){ return profile && profile.role === 'gc_admin'; }
function isActivityAdmin(){ return profile && profile.is_activity_admin === true; }
function canUpdateActivity(){ return profile && (profile.role === 'sub' || isActivityAdmin()); }
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
  $('userBadge').textContent=`${p.full_name || p.email} • ${p.role==='sub'?'Subcontractor':p.role==='gc_admin'?'GC Admin':'GC'}${p.is_activity_admin?' • Activity Editor':''}`;
  document.querySelectorAll('.gc-only').forEach(el=>el.classList.toggle('hidden',!isGC()));
  document.querySelectorAll('.admin-only').forEach(el=>el.classList.toggle('hidden',!(isAdmin() || isActivityAdmin())));
  document.querySelectorAll('.gc-admin-only').forEach(el=>el.classList.toggle('hidden',!isAdmin()));
  document.querySelectorAll('.activity-admin-only').forEach(el=>el.classList.toggle('hidden',!isActivityAdmin()));
  $('scheduleTitle').textContent = p.role==='sub' ? 'My Activities' : 'Remaining Schedule';
  await loadReferenceData();
  await loadActivities();
}

async function loadReferenceData(){
  let {data:pr}=await sb.from('projects').select('*').order('project_name'); projects=pr||[];
  let {data:co}=await sb.from('companies').select('*').order('company_name'); companies=co||[];
  if(isGC()){ let {data:pf}=await sb.from('profiles').select('*').order('full_name'); profiles=pf||[]; }
  renderProjectOptions(); renderCompanies(); renderUsers(); renderAdminActivities();
  if(!selectedProjectId && projects.length) selectedProjectId=projects[0].id;
  if(selectedProjectId) $('projectSelect').value=selectedProjectId;
  updateProjectLabel();
}

function renderProjectOptions(){
  $('projectSelect').innerHTML = projects.length ? projects.map(p=>`<option value="${p.id}">${esc(p.project_name)}</option>`).join('') : '<option value="">No projects</option>';
  $('projectList').innerHTML = projects.map(p=>`<div class="mini-row"><span>${esc(p.project_name)}</span><span>${p.active?'Active':'Inactive'}</span></div>`).join('');
}
function renderCompanies(){
  if($('tradeFilter')) $('tradeFilter').innerHTML='<option value="">All Trades</option>'+companies.map(c=>`<option value="${c.id}">${esc(c.company_name)}</option>`).join('');
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
  $('userBody').innerHTML=profiles.map(p=>{
    const protectedUser = p.id===profile?.id || p.is_activity_admin===true;
    const deleteButton = protectedUser
      ? '<button class="danger" type="button" disabled title="This admin account is protected">Delete</button>'
      : `<button class="danger delete-user" type="button" data-id="${p.id}">Delete</button>`;
    return `<tr><td>${esc(p.full_name||'')}</td><td>${esc(p.email||'')}</td><td>${esc(p.role)}</td><td>${esc(companyName(p.company_id))}</td><td>${p.active?'Yes':'No'}</td><td class="user-actions"><button class="ghost set-password" data-id="${p.id}">Set Password</button> <button class="ghost toggle-user" data-id="${p.id}" data-active="${p.active}">${p.active?'Deactivate':'Activate'}</button> ${deleteButton}</td></tr>`;
  }).join('');
  document.querySelectorAll('.toggle-user').forEach(b=>b.onclick=()=>toggleUser(b.dataset.id,b.dataset.active!=='true'));
  document.querySelectorAll('.set-password').forEach(b=>b.onclick=()=>openPasswordModal(b.dataset.id));
  document.querySelectorAll('.delete-user').forEach(b=>b.onclick=()=>deleteUser(b.dataset.id));
}
function updateProjectLabel(){ const p=projects.find(x=>x.id===selectedProjectId); $('projectLabel').textContent=p?.project_name||'No project selected'; $('scheduleSubtitle').textContent=profile?.role==='sub' ? companyName(profile.company_id) : 'Live subcontractor updates'; }

$('projectSelect')?.addEventListener('change',async e=>{selectedProjectId=e.target.value;updateProjectLabel();await loadActivities();});
$('refreshBtn')?.addEventListener('click',async()=>{await loadReferenceData();await loadActivities();toast('Schedule refreshed');});

async function loadActivities(){
  if(!selectedProjectId){ activities=[];renderActivities();return; }
  let q=sb.from('activities').select('*').eq('project_id',selectedProjectId).order('current_start',{ascending:true,nullsFirst:false});
  const {data,error}=await q;
  if(error){toast(error.message);return;}
  activities=data||[]; renderActivities(); renderAdminActivities();
}

function filteredActivities(){
  const q=($('searchInput').value||'').toLowerCase(); const trade=$('tradeFilter')?.value||''; const status=$('statusFilter').value;
  const today=new Date(); today.setHours(0,0,0,0); let horizon=null;
  if(['4','6'].includes(currentRange)){ horizon=new Date(today); horizon.setDate(horizon.getDate()+(Number(currentRange)*7)); }
  return activities.filter(a=>{
    if(currentRange==='all' && a.status==='Complete') return false;
    if(currentRange==='changed' && a.original_start===a.current_start && a.original_finish===a.current_finish) return false;
    if(horizon){
      const s=a.current_start?new Date(a.current_start+'T12:00:00'):null; const f=a.current_finish?new Date(a.current_finish+'T12:00:00'):s;
      if(!s || !f || s>horizon || f<today) return false;
    }
    if(trade && a.company_id!==trade) return false;
    if(status && a.status!==status) return false;
    const hay=[a.activity_code,a.activity_name,a.area,companyName(a.company_id)].join(' ').toLowerCase();
    if(q && !hay.includes(q)) return false;
    return true;
  });
}
function renderActivities(){
  const rows=filteredActivities(); $('emptyState').classList.toggle('hidden',rows.length>0);
  $('activityBody').innerHTML=rows.map(a=>{
    const startChanged=a.original_start!==a.current_start, finishChanged=a.original_finish!==a.current_finish;
    return `<tr>
      <td class="gc-only ${!isGC()?'hidden':''}">${esc(companyName(a.company_id))}</td>
      <td><strong>${esc(a.activity_code)}</strong></td><td>${esc(a.area||'')}</td><td>${esc(a.activity_name)}</td>
      <td>${fmt(a.original_start)}</td><td>${baselineDuration(a)==null?'—':`${baselineDuration(a)}d`}</td><td>${fmt(a.original_finish)}</td>
      <td><span class="${startChanged?'changed-date':''}">${fmt(a.current_start)}</span></td><td><span class="${finishChanged?'changed-date':''}">${fmt(a.current_finish)}</span></td>
      <td><span class="status">${esc(a.status)}</span></td><td>${a.percent_complete}%</td>
      <td>${canUpdateActivity()?`<button class="ghost edit-act" data-id="${a.id}">${isActivityAdmin()?'Edit':'Update'}</button>`:'<span class="muted small">View only</span>'}</td></tr>`;
  }).join('');
  document.querySelectorAll('.edit-act').forEach(b=>b.onclick=()=>openEdit(b.dataset.id));
  renderStats(rows);
}
function renderStats(rows=filteredActivities()){
  const today=isoDate(new Date());
  // Stats always reflect the activities currently visible under the active filters.
  const remaining=rows.filter(a=>a.status!=='Complete').length;
  const delayed=rows.filter(a=>a.status==='Delayed' || (a.current_finish && a.current_finish<today && a.status!=='Complete')).length;
  const changed=rows.filter(a=>a.original_start!==a.current_start || a.original_finish!==a.current_finish).length;
  const progress=rows.filter(a=>a.status==='In Progress').length;
  $('stats').innerHTML=[['Remaining',remaining],['In Progress',progress],['Delayed / Past Due',delayed],['Date Changes',changed]].map(([l,n])=>`<div class="stat"><div class="num">${n}</div><div class="label">${l}</div></div>`).join('');
}

['searchInput','tradeFilter','statusFilter'].forEach(id=>$(id)?.addEventListener(id==='searchInput'?'input':'change',renderActivities));
document.querySelectorAll('.range-btn').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.range-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');currentRange=b.dataset.range;renderActivities();}));

$('editStart')?.addEventListener('change', autoFillEditFinish);
$('adminCurrentStart')?.addEventListener('change', autoFillAdminFinish);
$('adminDuration')?.addEventListener('change', ()=>{ if($('adminCurrentStart')?.value) autoFillAdminFinish(); });

function openEdit(id){
  if(!canUpdateActivity()) return;
  const a=activities.find(x=>x.id===id); if(!a)return;
  if(isActivityAdmin()){ openAdminActivity(a); return; }
  $('editId').value=a.id;$('editTitle').textContent=a.activity_name;$('editCode').textContent=`${a.activity_code} • ${a.area||'No area'}`;
  $('baselineDates').textContent=`${fmt(a.original_start)} • ${baselineDuration(a)==null?'—':baselineDuration(a)+'d'} • ${fmt(a.original_finish)}`;$('editStart').value=a.current_start||'';$('editFinish').value=a.current_finish||'';$('editStatus').value=a.status;$('editPercent').value=a.percent_complete;$('editNotes').value=a.notes||'';
  if($('editStart').value && !$('editFinish').value) autoFillEditFinish();
  $('editModal').classList.remove('hidden');
}
$('closeModal')?.addEventListener('click',()=>$('editModal').classList.add('hidden'));
$('editModal')?.addEventListener('click',e=>{if(e.target===$('editModal'))$('editModal').classList.add('hidden')});
$('editForm')?.addEventListener('submit',async e=>{
  e.preventDefault(); const id=$('editId').value;
  const patch={current_start:$('editStart').value||null,current_finish:$('editFinish').value||null,status:$('editStatus').value,percent_complete:Number($('editPercent').value||0),notes:$('editNotes').value.trim()||null};
  if(patch.current_start && patch.current_finish && patch.current_finish<patch.current_start){toast('Finish date cannot be before start date');return;}
  const {error}=await sb.from('activities').update(patch).eq('id',id); if(error){toast(error.message);return;}
  $('editModal').classList.add('hidden');toast('Activity updated');await loadActivities();
});

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
  const {data,error}=await sb.from('activity_history').select('*').in('activity_id',ids).order('changed_at',{ascending:false}).limit(250);
  if(error){toast(error.message);return;}
  $('historyBody').innerHTML=(data||[]).map(h=>{const a=activities.find(x=>x.id===h.activity_id);return `<tr><td>${new Date(h.changed_at).toLocaleString()}</td><td>${esc(a?.activity_code||'')}</td><td>${esc(profileName(h.changed_by))}</td><td>${fmt(h.old_start)} → ${fmt(h.new_start)}</td><td>${fmt(h.old_finish)} → ${fmt(h.new_finish)}</td><td>${esc(h.old_status||'')} → ${esc(h.new_status||'')}</td><td>${esc(h.comment||'')}</td></tr>`}).join('');
}

$('projectForm')?.addEventListener('submit',async e=>{e.preventDefault();const name=$('newProjectName').value.trim();if(!name)return;const {error}=await sb.from('projects').insert({project_name:name});if(error){toast(error.message);return;}$('newProjectName').value='';toast('Project added');await loadReferenceData();});
$('companyForm')?.addEventListener('submit',async e=>{e.preventDefault();const company_name=$('newCompanyName').value.trim();const trade=$('newTradeName').value.trim()||null;if(!company_name)return;const {error}=await sb.from('companies').insert({company_name,trade});if(error){toast(error.message);return;}$('newCompanyName').value='';$('newTradeName').value='';toast('Company added');await loadReferenceData();});

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
function renderAdminActivities(){
  if(!isActivityAdmin() || !$('adminActivityBody')) return;
  const grouped={};
  activities.forEach(a=>{
    const area=adminAreaLabel(a);
    (grouped[area] ||= []).push(a);
  });
  const orderedAreas=Object.keys(grouped).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
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
$('collapseAllAreasBtn')?.addEventListener('click',collapseAllAdminAreas);
$('expandAllAreasBtn')?.addEventListener('click',expandAllAdminAreas);
initCompaniesTradesCollapse();
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
  $('adminPercent').value=a?.percent_complete??0;
  $('adminNotes').value=a?.notes||'';
  if($('adminCurrentStart').value && !$('adminCurrentFinish').value) autoFillAdminFinish();
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
    percent_complete:Number($('adminPercent').value||0),
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
      batch.push({project_id:selectedProjectId,company_id,activity_code:String(code).trim(),activity_name:String(name).trim(),area:String(pick(r,['area','location','building_area'])||'').trim()||null,original_start:start,original_finish:finish,current_start:currentStart,current_finish:currentFinish,duration_days:duration,status:'Not Started',percent_complete:0,source_upload:file.name});
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
