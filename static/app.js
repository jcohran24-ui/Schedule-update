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
const esc = (s='') => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function toast(msg){ const el=$('toast'); el.textContent=msg; el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'),2600); }
function isGC(){ return profile && ['gc','gc_admin'].includes(profile.role); }
function isAdmin(){ return profile && profile.role === 'gc_admin'; }
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

async function enterApp(s){
  session=s;
  const {data:p,error}=await sb.from('profiles').select('*').eq('id',s.user.id).single();
  if(error || !p || !p.active){ await sb.auth.signOut(); $('loginError').textContent='Your account is not active or has not been assigned a profile.'; return; }
  profile=p;
  $('loginScreen').classList.add('hidden'); $('appScreen').classList.remove('hidden');
  $('userBadge').textContent=`${p.full_name || p.email} • ${p.role==='sub'?'Subcontractor':p.role==='gc_admin'?'GC Admin':'GC'}`;
  document.querySelectorAll('.gc-only').forEach(el=>el.classList.toggle('hidden',!isGC()));
  document.querySelectorAll('.admin-only').forEach(el=>el.classList.toggle('hidden',!isAdmin()));
  $('scheduleTitle').textContent = p.role==='sub' ? 'My Activities' : 'Remaining Schedule';
  await loadReferenceData();
  await loadActivities();
}

async function loadReferenceData(){
  let {data:pr}=await sb.from('projects').select('*').order('project_name'); projects=pr||[];
  let {data:co}=await sb.from('companies').select('*').order('company_name'); companies=co||[];
  if(isGC()){ let {data:pf}=await sb.from('profiles').select('*').order('full_name'); profiles=pf||[]; }
  renderProjectOptions(); renderCompanies(); renderUsers();
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
}
function renderUsers(){
  if(!isAdmin() || !$('userBody')) return;
  $('userBody').innerHTML=profiles.map(p=>`<tr><td>${esc(p.full_name||'')}</td><td>${esc(p.email||'')}</td><td>${esc(p.role)}</td><td>${esc(companyName(p.company_id))}</td><td>${p.active?'Yes':'No'}</td><td><button class="ghost toggle-user" data-id="${p.id}" data-active="${p.active}">${p.active?'Deactivate':'Activate'}</button></td></tr>`).join('');
  document.querySelectorAll('.toggle-user').forEach(b=>b.onclick=()=>toggleUser(b.dataset.id,b.dataset.active!=='true'));
}
function updateProjectLabel(){ const p=projects.find(x=>x.id===selectedProjectId); $('projectLabel').textContent=p?.project_name||'No project selected'; $('scheduleSubtitle').textContent=profile?.role==='sub' ? companyName(profile.company_id) : 'Live subcontractor updates'; }

$('projectSelect')?.addEventListener('change',async e=>{selectedProjectId=e.target.value;updateProjectLabel();await loadActivities();});
$('refreshBtn')?.addEventListener('click',async()=>{await loadReferenceData();await loadActivities();toast('Schedule refreshed');});

async function loadActivities(){
  if(!selectedProjectId){ activities=[];renderActivities();return; }
  let q=sb.from('activities').select('*').eq('project_id',selectedProjectId).order('current_start',{ascending:true,nullsFirst:false});
  const {data,error}=await q;
  if(error){toast(error.message);return;}
  activities=data||[]; renderActivities(); renderStats();
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
      <td>${fmt(a.original_start)}</td><td><span class="${startChanged?'changed-date':''}">${fmt(a.current_start)}</span></td>
      <td>${fmt(a.original_finish)}</td><td><span class="${finishChanged?'changed-date':''}">${fmt(a.current_finish)}</span></td>
      <td><span class="status">${esc(a.status)}</span></td><td>${a.percent_complete}%</td>
      <td><button class="ghost edit-act" data-id="${a.id}">Update</button></td></tr>`;
  }).join('');
  document.querySelectorAll('.edit-act').forEach(b=>b.onclick=()=>openEdit(b.dataset.id));
}
function renderStats(){
  const today=isoDate(new Date());
  const remaining=activities.filter(a=>a.status!=='Complete').length;
  const delayed=activities.filter(a=>a.status==='Delayed' || (a.current_finish && a.current_finish<today && a.status!=='Complete')).length;
  const changed=activities.filter(a=>a.original_start!==a.current_start || a.original_finish!==a.current_finish).length;
  const progress=activities.filter(a=>a.status==='In Progress').length;
  $('stats').innerHTML=[['Remaining',remaining],['In Progress',progress],['Delayed / Past Due',delayed],['Date Changes',changed]].map(([l,n])=>`<div class="stat"><div class="num">${n}</div><div class="label">${l}</div></div>`).join('');
}

['searchInput','tradeFilter','statusFilter'].forEach(id=>$(id)?.addEventListener(id==='searchInput'?'input':'change',renderActivities));
document.querySelectorAll('.range-btn').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.range-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');currentRange=b.dataset.range;renderActivities();}));

function openEdit(id){
  const a=activities.find(x=>x.id===id); if(!a)return;
  $('editId').value=a.id;$('editTitle').textContent=a.activity_name;$('editCode').textContent=`${a.activity_code} • ${a.area||'No area'}`;
  $('baselineDates').textContent=`${fmt(a.original_start)} → ${fmt(a.original_finish)}`;$('editStart').value=a.current_start||'';$('editFinish').value=a.current_finish||'';$('editStatus').value=a.status;$('editPercent').value=a.percent_complete;$('editNotes').value=a.notes||'';
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
      const start=excelDate(pick(r,['start','start_date','baseline_start','current_start']));
      const finish=excelDate(pick(r,['finish','finish_date','baseline_finish','current_finish']));
      const durationRaw=pick(r,['duration','duration_days','remaining_duration']); const duration=durationRaw===null?null:parseInt(String(durationRaw),10)||null;
      batch.push({project_id:selectedProjectId,company_id,activity_code:String(code).trim(),activity_name:String(name).trim(),area:String(pick(r,['area','location','building_area'])||'').trim()||null,original_start:start,original_finish:finish,current_start:start,current_finish:finish,duration_days:duration,status:'Not Started',percent_complete:0,source_upload:file.name});
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
