(() => {
'use strict';
const ui=window.WittUI, $=s=>document.querySelector(s), esc=s=>{const n=document.createElement('span');n.textContent=String(s??'');return n.innerHTML.replaceAll('"','&quot;').replaceAll("'",'&#39;');};
let mode='projects', projects=[], schedules=[], pending=new Map(), activeProject=null, preview=null, returnFocus=null, busy=false;
const labels={queued:'排队中',running:'执行中',completed:'已完成',failed:'失败',interrupted:'已暂停',awaiting_confirmation:'等待确认',skipped:'跳过',launching:'准备中'};
const post=(method,...args)=>window.WittNative?.postMessage(JSON.stringify({method,args}));
async function request(endpoint,method='GET',body={}) {
 if(!window.WittNative){const r=await fetch('/vault-api/'+endpoint,{method,credentials:'same-origin',cache:'no-store',headers:method==='GET'?{}:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||'请求失败');return data;}
 if(!ui.workspaceOperations())throw Error('请先在设置中更新客户端');
 const id='workspace_'+crypto.randomUUID().replaceAll('-','');return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('请求超时，请重试'));},45000);pending.set(id,{resolve,reject,timer});post('workspaceRequest',endpoint,method,JSON.stringify(body),id);});
}
function shell(title,content){$('#featureTitle').textContent=title;$('#featureContent').innerHTML=content;$('#featurePanel').scrollTop=0;}
function close(){ $('#featureSheet').hidden=true;returnFocus?.focus({preventScroll:true}); }
function show(){returnFocus=document.activeElement;$('#closeDrawerAccount').click();$('#featureSheet').hidden=false;$('#featureClose').focus();}
const date=s=>s?new Date(s).toLocaleString():'';
const fmtSize=n=>{const v=Number(n||0);if(v<1024)return v+' B';if(v<1024*1024)return (v/1024).toFixed(1)+' KB';return (v/1024/1024).toFixed(1)+' MB';};
const button=(text,action,id='',cls='')=>`<button type="button" ${cls?`class="${cls}"`:''} data-feature="${action}" data-id="${esc(id)}">${esc(text)}</button>`;
const summarize=(text)=>{const clean=String(text||'').trim().replace(/\s+/g,' ');return clean.length>46?clean.slice(0,46)+'…':clean;};
async function uploadReferenceFile(projectId,file){
 if(!file)return;
 if(!window.WittNative){
  if(file.size>25*1024*1024)throw Error('单个参考文件不能超过 25 MB');
  const r=await fetch(`/vault-api/chat/projects/${projectId}/files`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name),'X-File-Type':file.type||'application/octet-stream'},body:file});
  const data=await r.json();if(!r.ok)throw Error(data.error||'上传失败');return data;
 }
 if(file.size>2*1024*1024)throw Error('移动端单次参考文件建议不超过 2 MB');
 const buf=new Uint8Array(await file.arrayBuffer());let bin='';for(let i=0;i<buf.length;i+=0x8000)bin+=String.fromCharCode(...buf.subarray(i,i+0x8000));
 return request('chat/projects/'+projectId,'PATCH',{addReference:{name:file.name,mimeType:file.type||'application/octet-stream',contentBase64:btoa(bin)}});
}
async function listProjects(){
 mode='projects';activeProject=null;
 const data=await request('chat/projects');
 projects=Array.isArray(data.projects)?data.projects:[];
 ui.syncProjects?.(projects);
 shell('我的项目',`<div class="feature-hero-bar"><p class="feature-note">每个项目仅自己可见，独立保存专属说明、参考文件、常用指令与对话。</p>${button('+ 新建项目','new-project')}</div><div class="feature-list">${projects.map(p=>`<button class="feature-card-item" data-feature="project" data-id="${p.id}"><div class="feature-card-head"><strong>${esc(p.name)}</strong><span class="feature-pill">${p.conversationCount||0} 对话${p.referenceCount?` · ${p.referenceCount} 资料`:''}</span></div><small>${p.instructions?esc(summarize(p.instructions)):'独立专属项目空间'}</small></button>`).join('')||'<div class="feature-empty-card"><p>还没有项目</p><small>点击上方“+ 新建项目”，按主题集中管理对话与资料。</small></div>'}</div>`);
}
async function project(id){
 mode='project';
 const data=await request('chat/projects/'+id);
 activeProject=data.project;const p=activeProject;
 const counts=new Map();
 (p.files||[]).forEach(f=>counts.set(f.name,(counts.get(f.name)||0)+1));
 const refs=Array.isArray(p.references)?p.references:[];
 shell(p.name,`<div class="feature-toolbar">${button('← 全部项目','projects')}${button('新建对话','project-chat',id)}${button('编辑','edit-project',id)}${button('删除','delete-project',id,'feature-danger feature-toolbar-end')}</div>
  ${p.instructions?`<section class="feature-section-card"><div class="feature-section-head"><h3>项目说明</h3></div><pre class="feature-instructions-pre">${esc(p.instructions)}</pre></section>`:''}
  <section class="feature-section-card">
    <div class="feature-section-head"><h3>参考文件（${refs.length}/20）</h3>${button('+ 上传','upload-reference',id,'feature-btn-sm')}</div>
    <p class="feature-note">上传的文档、规范或素材会被本项目下所有对话自动读取。</p>
    <div class="feature-list">${refs.map(r=>`<article class="reference-row"><div><strong>${esc(r.name)}</strong><small>${esc(fmtSize(r.size))} · ${esc(date(r.createdAt))}</small></div>${button('移除','remove-reference',r.id,'feature-danger reference-remove')}</article>`).join('')||'<p class="feature-note">暂未上传参考文件。</p>'}</div>
  </section>
  <section class="feature-section-card">
    <div class="feature-section-head"><h3>常用指令</h3></div>
    <div class="feature-toolbar">${(p.shortcuts||[]).map((s,i)=>button(s.name,'shortcut',i)).join('')||'<span class="feature-note">编辑项目可添加常用指令，新对话时一点即用。</span>'}</div>
  </section>
  <section class="feature-section-card">
    <div class="feature-section-head"><h3>对话（${(p.conversations||[]).length}）</h3></div>
    <div class="feature-list">${(p.conversations||[]).map(c=>`<button data-feature="conversation" data-id="${c.id}"><div class="feature-card-head"><strong>${esc(c.title)}</strong><span class="feature-pill">${esc(labels[c.taskStatus?.state]||'打开')}</span></div></button>`).join('')||'<p class="feature-note">还没有对话，点上方“新建对话”开始。</p>'}</div>
  </section>
  <section class="feature-section-card">
    <div class="feature-section-head"><h3>交付文件（${(p.files||[]).length}）</h3></div>
    <div class="feature-list">${(p.files||[]).map((f,i)=>`<button data-feature="project-file" data-id="${i}"><strong>${esc(f.name)}</strong><small>${counts.get(f.name)>1?'同名文件 · ':''}${esc(date(f.createdAt))}</small></button>`).join('')||'<p class="feature-note">项目中交付的文件会自动汇总在这里。</p>'}</div>
  </section>`);
}
function projectForm(p={}){
 mode='project-form';
 shell(p.id?'编辑项目':'新建项目',`<form id="featureForm" data-kind="project" data-id="${p.id||''}"><label>项目名称<input name="name" maxlength="80" required placeholder="例如：毕业论文、周报助手、个人应用" value="${esc(p.name||'')}"></label><label>项目说明（选填）<textarea name="instructions" maxlength="12000" rows="5" placeholder="例如：背景信息、回复风格、代码规范或长期要求">${esc(p.instructions||'')}</textarea></label><label>常用指令（选填）<textarea name="shortcuts" rows="4" placeholder="每行一个：名称 | 任务要求&#10;例如：整理周报 | 请把本周进展整理成结构化周报">${esc((p.shortcuts||[]).map(s=>s.name+' | '+s.prompt).join('\n'))}</textarea></label><p class="feature-note">项目仅你本人可见，系统自动分配独立文件空间。</p><div class="feature-toolbar"><button type="submit">保存项目</button>${button('取消',p.id?'project':'projects',p.id||'')}</div></form>`);
}
function deleteProjectConfirm(p){
 mode='project-delete';
 shell('删除项目',`<section class="feature-section-card"><p class="feature-note">确定删除项目「<strong>${esc(p.name)}</strong>」吗？删除后原有聊天记录会保留，并自动转为“不归属项目”。</p><label class="feature-checkbox"><input type="checkbox" id="deleteProjectFiles"> 同时清理该项目空间及参考文件（不可恢复）</label><div class="feature-toolbar">${button('确认删除','confirm-delete-project',p.id,'feature-danger')}${button('取消','project',p.id)}</div></section>`);
}
async function listSchedules(){
 mode='schedules';
 const data=await request('chat/schedules');
 schedules=data.schedules;
 shell('定时任务',`<div class="feature-hero-bar"><p class="feature-note">到时间由服务器自动新建对话执行，保留历史记录；新计划沿用当前账号与模型。</p>${button('+ 新建定时任务','new-schedule')}</div><div class="feature-list">${schedules.map(s=>`<article class="schedule-card"><div class="feature-card-head"><strong>${esc(s.name)}</strong><span class="feature-pill ${s.enabled?'is-active':''}">${s.enabled?'已启用':'已暂停'}</span></div><small>${s.enabled?'下次执行：'+esc(date(s.nextAt)):'当前未排期'} · ${s.intervalMinutes?'每 '+s.intervalMinutes+' 分钟':'仅执行一次'}</small><div class="feature-toolbar">${button('编辑','edit-schedule',s.id)}${button(s.enabled?'暂停':'启用','toggle-schedule',s.id)}${button('立即执行','run-schedule',s.id)}</div>${s.runs.length?`<div class="schedule-runs">${s.runs.slice(-4).reverse().map(r=>`<div class="schedule-run-row"><span>${esc(date(r.createdAt))} · ${esc(labels[r.taskStatus]||labels[r.state]||r.state)}</span>${r.conversationId?button('查看','conversation',r.conversationId,'feature-btn-sm'):`<small>${esc(r.detail||'')}</small>`}</div>`).join('')}</div>`:''}</article>`).join('')||'<div class="feature-empty-card"><p>还没有定时任务</p><small>可设置每日巡检、定时总结等自动任务。</small></div>'}</div>`);
}
async function scheduleForm(s={}){mode='schedule-form';projects=(await request('chat/projects')).projects;const d=new Date(s.nextAt||Date.now()+3600000),local=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);shell(s.id?'编辑定时任务':'新建定时任务',`<form id="featureForm" data-kind="schedule" data-id="${s.id||''}"><label>名称<input name="name" maxlength="80" required value="${esc(s.name||'')}"></label><label>任务要求<textarea name="prompt" maxlength="8000" rows="5" required>${esc(s.prompt||'')}</textarea></label><label>所属项目<select name="projectId"><option value="">不归属项目</option>${projects.map(p=>`<option value="${p.id}" ${s.projectId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label>开始时间（本机时区）<input name="nextAt" type="datetime-local" required value="${local}"></label><label>重复间隔（分钟，0 表示仅一次）<input name="intervalMinutes" type="number" min="0" max="10080" required value="${s.intervalMinutes||0}"></label><div class="feature-toolbar"><button type="submit">保存并启用</button>${button('取消','schedules')}</div></form>`);}
function drawPreview(data){shell(data.name,`<div class="feature-toolbar">${button('下载原文件','download')}${data.kind==='pdf-page'?`${button('上一页','prev-page')}<span>${data.page} / ${data.pages}</span>${button('下一页','next-page')}`:''}</div>${data.kind==='text'?`<pre class="file-text"></pre>`:`<img class="file-image" alt="${esc(data.name)}">`}`);if(data.kind==='text')$('.file-text').textContent=data.content;else $('.file-image').src='data:'+data.mimeType+';base64,'+data.content;if(data.kind==='pdf-page'){preview.page=data.page;preview.pages=data.pages; $('[data-feature="prev-page"]').disabled=data.page<=1;$('[data-feature="next-page"]').disabled=data.page>=data.pages;}}
async function loadPreview(page=1){shell(preview.artifact.name,'<p>正在读取文件…</p>');try{const data=await request(`chat/conversations/${preview.conversationId}/artifact-content?messageId=${encodeURIComponent(preview.artifact.messageId)}&artifactId=${encodeURIComponent(preview.artifact.id)}&page=${page}`);drawPreview(data);}catch(e){shell(preview.artifact.name,`<p>${esc(e.message)}</p>${button('下载原文件','download')}`);}}
async function previewFile(conversationId,artifact){preview={conversationId,artifact,page:1};mode='preview';show();await loadPreview();}
function notifySettings(s){const b=$('#featureNotifications');if(!b)return;b.dataset.enabled=String(Boolean(s.enabled));b.setAttribute('aria-pressed',String(Boolean(s.enabled)));const lbl=$('#featureNotificationsLabel');if(lbl)lbl.textContent='后台任务通知';if(s.permission===false)ui.toast('请在系统中允许通知后，再点击开启');}
window.WittFeatures={request,onResponse(id,ok,json){const p=pending.get(id);if(!p)return;pending.delete(id);clearTimeout(p.timer);try{const data=typeof json==='string'?JSON.parse(json):json;ok?p.resolve(data):p.reject(Error(data.error||'请求失败'));}catch{p.reject(Error('响应格式错误'));}},onNotificationSettings:notifySettings,openConversation(id){close();ui.refreshSummaries();ui.select(id);},openProjects(){show();listProjects().catch(e=>ui.toast(e.message));},openProject(id){show();project(id).catch(e=>ui.toast(e.message));},preview:previewFile,watch(conversations){if(ui.workspaceOperations())post('watchTasks',JSON.stringify(conversations.map(c=>({id:c.id,busy:!!c.busy}))));}};
$('#featureClose').onclick=close;$('#featureBackdrop').onclick=close;
$('#featureProjects').onclick=()=>{show();listProjects().catch(e=>ui.toast(e.message));};$('#featureSchedules').onclick=()=>{show();listSchedules().catch(e=>ui.toast(e.message));};
$('#drawerAvatar').addEventListener('click',()=>{if(ui.workspaceOperations())post('taskNotificationSettings','{}');});
$('#featureNotifications').hidden=!window.WittNative;
$('#featureNotifications').onclick=()=>{if(!window.WittNative){ui.toast('后台任务通知需要使用安卓客户端');return;}if(!ui.workspaceOperations()){ui.toast('请先更新客户端');return;}post('taskNotificationSettings',JSON.stringify({enabled:$('#featureNotifications').dataset.enabled!=='true'}));};
$('#featureContent').addEventListener('click',async e=>{const b=e.target.closest('[data-feature]');if(!b||busy)return;const a=b.dataset.feature,id=b.dataset.id;busy=true;b.disabled=true;try{if(a==='projects')await listProjects();else if(a==='project')await project(id);else if(a==='new-project')projectForm();else if(a==='edit-project')projectForm(activeProject);else if(a==='delete-project'&&activeProject)deleteProjectConfirm(activeProject);else if(a==='confirm-delete-project'){const removeFiles=Boolean($('#deleteProjectFiles')?.checked);await request('chat/projects/'+id,'PATCH',{deleted:true,removeFiles});ui.toast('项目已删除');await listProjects();ui.refreshSummaries();}else if(a==='upload-reference'&&activeProject){const input=document.createElement('input');input.type='file';input.multiple=true;input.onchange=async()=>{const files=[...(input.files||[])];if(!files.length)return;try{for(const file of files)await uploadReferenceFile(activeProject.id,file);ui.toast(`已上传 ${files.length} 个参考文件`);await project(activeProject.id);ui.syncProjects?.();}catch(err){ui.toast(err.message);}};input.click();}else if(a==='remove-reference'&&activeProject){await request('chat/projects/'+activeProject.id,'PATCH',{removeReferenceId:id});ui.toast('已移除参考文件');await project(activeProject.id);ui.syncProjects?.();}else if(a==='project-chat'||a==='shortcut'){const data=await request('chat/projects/'+activeProject.id+'/conversations','POST',ui.settings());window.DropVault.onConversationCreated(JSON.stringify(data));close();ui.syncProjects?.();if(a==='shortcut')ui.draft(activeProject.shortcuts[Number(id)].prompt);}else if(a==='conversation'){close();ui.select(id);}else if(a==='project-file'){const f=activeProject.files[Number(id)];await previewFile(f.conversationId,f);}else if(a==='schedules')await listSchedules();else if(a==='new-schedule')await scheduleForm();else if(a==='edit-schedule')await scheduleForm(schedules.find(s=>s.id===id));else if(a==='toggle-schedule'){const s=schedules.find(s=>s.id===id);await request('chat/schedules/'+id,'PATCH',{enabled:!s.enabled});await listSchedules();}else if(a==='run-schedule'){await request('chat/schedules/'+id+'/run','POST',{});ui.toast('已提交执行');await listSchedules();ui.refreshSummaries();}else if(a==='download')ui.download(preview.conversationId,preview.artifact);else if(a==='prev-page'||a==='next-page')await loadPreview(preview.page+(a==='prev-page'?-1:1));}catch(err){ui.toast(err.message);}finally{busy=false;if(b.isConnected)b.disabled=false;}});
$('#featureContent').addEventListener('submit',async e=>{const form=e.target;if(form.id!=='featureForm')return;e.preventDefault();if(busy)return;busy=true;const btn=form.querySelector('[type="submit"]');btn.disabled=true;try{const v=Object.fromEntries(new FormData(form));const id=form.dataset.id;if(form.dataset.kind==='project'){v.shortcuts=v.shortcuts.split('\n').filter(s=>s.trim()).map(line=>{const i=line.indexOf('|');if(i<1)throw Error('常用指令格式：名称 | 任务要求');return {name:line.slice(0,i).trim(),prompt:line.slice(i+1).trim()};});const data=await request('chat/projects'+(id?'/'+id:''),id?'PATCH':'POST',v);await project(data.project.id);ui.syncProjects?.();ui.refreshSummaries();}else{v.projectId=v.projectId||null;v.nextAt=new Date(v.nextAt).toISOString();v.intervalMinutes=Number(v.intervalMinutes);v.enabled=true;if(!id){const config=ui.settings();v.model=config.model;v.codexProfile=config.codexProfile;}await request('chat/schedules'+(id?'/'+id:''),id?'PATCH':'POST',v);await listSchedules();}}catch(err){ui.toast(err.message);}finally{busy=false;if(btn.isConnected)btn.disabled=false;}});
document.addEventListener('keydown',e=>{if($('#featureSheet').hidden)return;if(e.key==='Escape'){e.preventDefault();close();}if(e.key==='Tab'){const nodes=[...$('#featurePanel').querySelectorAll('button:not([disabled]),input,textarea,select,summary')].filter(n=>n.getClientRects().length);if(e.shiftKey&&document.activeElement===nodes[0]){e.preventDefault();nodes.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===nodes.at(-1)){e.preventDefault();nodes[0]?.focus();}}});
})();
