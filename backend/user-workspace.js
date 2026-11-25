'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const execFile=require('node:util').promisify(require('node:child_process').execFile);
const ID=/^[a-f0-9-]{36}$/;
class UserWorkspace {
 constructor(service,{clock=()=>Date.now(),start=true}={}){
  this.service=service;this.clock=clock;this.file=path.join(service.chatDir,'workspace-state.json');
  this.data={projects:[],schedules:[],events:[],sequence:0};
  if(fs.existsSync(this.file))this.data={...this.data,...JSON.parse(fs.readFileSync(this.file,'utf8'))};
  this.ticking=false;if(start){this.timer=setInterval(()=>this.tick(),15000);this.timer.unref();setImmediate(()=>this.tick());}
 }
 save(){const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.data),{mode:0o600});fs.renameSync(tmp,this.file);}
 event(conversation,state){this.data.events.push({sequence:++this.data.sequence,conversationId:conversation.id,title:conversation.title,state,createdAt:new Date(this.clock()).toISOString()});this.data.events=this.data.events.slice(-512);this.save();}
 projectById(id){return typeof id==='string'&&ID.test(id)?this.data.projects.find(item=>item.id===id)||null:null;}
 projectFor(conversation){return this.projectById(conversation?.workspaceProjectId);}
 projectDir(projectOrId){
  const id=typeof projectOrId==='string'?projectOrId:projectOrId?.id;
  if(!ID.test(String(id||'')))throw new Error('项目编号无效');
  const root=path.resolve(this.service.projectsDir);
  const dir=path.resolve(root,id);
  if(!dir.startsWith(root+path.sep))throw new Error('项目空间路径无效');
  return dir;
 }
 ensureProjectDir(projectOrId){
  const dir=this.projectDir(projectOrId);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  return dir;
 }
 projectReferencesDir(projectOrId){
  const dir=path.join(this.ensureProjectDir(projectOrId),'.references');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  return dir;
 }
 projectReferencesFor(project){
  if(!project||!Array.isArray(project.references))return [];
  const base=path.join(this.projectDir(project),'.references');
  return project.references.map(ref=>{
   const filePath=path.join(base,String(ref.storedName||''));
   return {id:ref.id,name:ref.name,size:Number(ref.size||0),mimeType:String(ref.mimeType||'application/octet-stream'),createdAt:ref.createdAt||null,path:filePath,exists:Boolean(ref.storedName)&&fs.existsSync(filePath)};
  }).filter(ref=>ref.exists);
 }
 publicProject(project){
  const references=this.projectReferencesFor(project).map(({path:_,exists:__,...pub})=>pub);
  return {
   id:project.id,
   name:project.name,
   instructions:String(project.instructions||''),
   shortcuts:Array.isArray(project.shortcuts)?project.shortcuts:[],
   references,
   referenceCount:references.length,
   createdAt:project.createdAt||null,
   updatedAt:project.updatedAt||project.createdAt||null,
  };
 }
 canonicalDirectory(conversation){try{return fs.realpathSync(this.service.effectiveWorkDir(conversation));}catch{return path.resolve(this.service.effectiveWorkDir(conversation));}}
 landingDirectories(){
  const dirs=new Set(['/home/ubuntu','/var/lib/witt']);
  for(const candidate of ['/home/ubuntu','/var/lib/witt',this.service.userWorkspaceDir]){
   if(!candidate)continue;
   dirs.add(path.resolve(candidate));
   try{dirs.add(fs.realpathSync(candidate));}catch{}
  }
  return dirs;
 }
 conflict(conversation){
  if(conversation.accessMode==='read-only')return null;
  const directory=this.canonicalDirectory(conversation);
  const landing=this.landingDirectories();
  for(const active of this.service.activeTurns.values()){
   if(active.conversationId===conversation.id)continue;
   const other=this.service.readConversation(active.conversationId);
   if(!other||other.accessMode==='read-only')continue;
   if(conversation.workspaceProjectId&&conversation.workspaceProjectId===other.workspaceProjectId)return {conversationId:other.id,title:other.title};
   const otherDir=this.canonicalDirectory(other);
   // Shared landing directories are not a single source project.
   if(!conversation.workspaceProjectId&&!other.workspaceProjectId&&(landing.has(directory)||landing.has(otherDir)))continue;
   if(directory===otherDir||directory.startsWith(otherDir+path.sep)||otherDir.startsWith(directory+path.sep))return {conversationId:other.id,title:other.title};
  }
  return null;
 }
 queuePosition(id){if(!this.queueCache||this.queueCache.expires<this.clock())this.queueCache={expires:this.clock()+250,items:this.queued()};const index=this.queueCache.items.findIndex(item=>item.conversation.id===id);return index>=0?index+1:null;}
 queued(){const result=[];for(const meta of this.service.store.listMetadata()){if(meta.archived||!meta.busy||this.service.activeFor(meta.id))continue;const c=this.service.readConversation(meta.id);const assistant=c?.messages.find(m=>m.role==='assistant'&&m.status==='queued');if(assistant)result.push({conversation:c,assistant});}return result.sort((a,b)=>String(a.assistant.createdAt).localeCompare(String(b.assistant.createdAt))||a.assistant.id.localeCompare(b.assistant.id));}
 cancel(id,deviceId){const c=this.service.readConversation(id);if(!c||c.archived)throw new Error('对话不存在');const queued=c.messages.filter(m=>m.role==='assistant'&&m.status==='queued');let count=0;
  for(const assistant of queued){const user=c.messages.find(m=>m.id===assistant.replyTo);if(user?.senderDeviceId&&user.senderDeviceId!==deviceId)continue;assistant.status='interrupted';assistant.completedAt=new Date(this.clock()).toISOString();assistant.text='已取消排队，尚未执行任何操作。';if(user)user.status='completed';count++;}
  if(!count)throw new Error('没有可由本设备取消的排队任务');c.updatedAt=new Date(this.clock()).toISOString();this.service.writeConversation(c);if(!this.service.activeFor(id))this.event(c,'interrupted');return {ok:true,cancelled:count,conversation:this.service.publicConversation(c)};
 }
 retry(id,deviceId){const c=this.service.readConversation(id);if(!c||c.archived)throw new Error('对话不存在');if(this.service.activeFor(id)||c.messages.some(m=>m.role==='assistant'&&['queued','running'].includes(m.status)))throw new Error('当前任务尚未结束');
  const assistant=c.messages.findLast(m=>m.role==='assistant');if(!assistant||!['failed','interrupted'].includes(assistant.status))throw new Error('只有失败或已暂停的任务可以重试');
  const user=c.messages.find(m=>m.id===assistant.replyTo);if(!user)throw new Error('没有可重试的原始要求');
  const response=this.submit(id,deviceId,{text:user.text,attachmentIds:(user.attachments||[]).map(f=>f.id),clientRequestId:'retry-'+assistant.id});if(response.status>=400)throw new Error(response.payload.error);return response.payload;
 }
 projectConversations(projectId){
  return this.service.store.listMetadata()
   .filter(c=>!c.archived&&c.workspaceProjectId===projectId)
   .sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
 }
 projectPayload(project){
  const conversations=this.projectConversations(project.id).map(c=>this.service.publicConversation(c,false));
  const files=[];
  for(const meta of conversations){
   const c=this.service.readConversation(meta.id);
   for(const m of c?.messages||[])for(const a of m.artifacts||[])files.push({id:a.id,messageId:m.id,conversationId:c.id,name:a.name,size:a.size,mimeType:a.mimeType,createdAt:m.completedAt||m.createdAt});
  }
  return {...this.publicProject(project),conversationCount:conversations.length,fileCount:files.length,conversations,files:files.slice(-100).reverse()};
 }
 validateProject(body,previous={}){
  const name=String(body.name??previous.name??'').trim();
  if(!name||name.length>80||/[\x00-\x1f]/.test(name))throw new Error('项目名称须为 1–80 个字符');
  const instructions=String(body.instructions??previous.instructions??'');
  if(instructions.length>12000)throw new Error('项目说明过长');
  const shortcuts=body.shortcuts??previous.shortcuts??[];
  if(!Array.isArray(shortcuts)||shortcuts.length>12||shortcuts.some(x=>typeof x.name!=='string'||!x.name.trim()||x.name.length>40||typeof x.prompt!=='string'||!x.prompt.trim()||x.prompt.length>4000))throw new Error('常用指令格式无效');
  const now=new Date(this.clock()).toISOString();
  const normalizedShortcuts=shortcuts.map(x=>({name:x.name.trim(),prompt:x.prompt.trim()}));
  return {
   ...(previous.id?{id:previous.id,createdAt:previous.createdAt||now,references:Array.isArray(previous.references)?previous.references:[]}:{}),
   name,
   instructions,
   shortcuts:normalizedShortcuts,
   updatedAt:now,
  };
 }
 addReferenceFile(project,name,mimeType,buffer){
  if(!Array.isArray(project.references))project.references=[];
  if(project.references.length>=20)throw new Error('每个项目最多保存 20 个参考文件');
  const maxBytes=25*1024*1024;
  if(!Buffer.isBuffer(buffer)||!buffer.length)throw new Error('参考文件内容为空');
  if(buffer.length>maxBytes)throw new Error('单个参考文件不能超过 25 MB');
  const safeName=path.basename(String(name||'未命名文件').replace(/[\x00-\x1f/\\]+/g,' ').trim()).slice(0,140)||'未命名文件';
  const ext=path.extname(safeName).replace(/[^a-zA-Z0-9.]/g,'').slice(0,16);
  const id=crypto.randomUUID();
  const storedName=`${id}${ext}`;
  const dir=this.projectReferencesDir(project);
  fs.writeFileSync(path.join(dir,storedName),buffer,{mode:0o600});
  const ref={id,name:safeName,storedName,size:buffer.length,mimeType:String(mimeType||'application/octet-stream').slice(0,120),createdAt:new Date(this.clock()).toISOString()};
  project.references.push(ref);
  project.updatedAt=ref.createdAt;
  this.save();
  return {id:ref.id,name:ref.name,size:ref.size,mimeType:ref.mimeType,createdAt:ref.createdAt};
 }
 removeReferenceFile(project,refId){
  if(!Array.isArray(project.references))return false;
  const idx=project.references.findIndex(item=>item.id===refId);
  if(idx<0)return false;
  const [removed]=project.references.splice(idx,1);
  try{fs.rmSync(path.join(this.projectDir(project),'.references',String(removed.storedName||'')),{force:true});}catch{}
  project.updatedAt=new Date(this.clock()).toISOString();
  this.save();
  return true;
 }
 syncProjectNameToConversations(project){
  for(const meta of this.service.store.listMetadata()){
   if(meta.workspaceProjectId!==project.id)continue;
   const c=this.service.readConversation(meta.id);
   if(!c||c.project===project.name)continue;
   c.project=project.name;
   this.service.writeConversation(c);
  }
 }
 deleteProject(projectId,{removeFiles=false}={}){
  const index=this.data.projects.findIndex(p=>p.id===projectId);
  if(index<0)return null;
  const [removed]=this.data.projects.splice(index,1);
  for(const meta of this.service.store.listMetadata()){
   if(meta.workspaceProjectId!==projectId)continue;
   const c=this.service.readConversation(meta.id);
   if(!c)continue;
   c.workspaceProjectId=null;
   if(c.project===removed.name)c.project='';
   c.workDir=null;
   if(c.codexThreadId){
    c.projectSwitchNotice={fromName:removed.name,toName:'',instructions:'',workDir:this.service.effectiveWorkDir(c)};
   }
   this.service.writeConversation(c);
  }
  for(const schedule of this.data.schedules){
   if(schedule.projectId===projectId)schedule.projectId=null;
  }
  if(removeFiles){
   try{fs.rmSync(this.projectDir(projectId),{recursive:true,force:true});}catch{}
  }
  this.save();
  return {ok:true,deletedId:projectId};
 }
 createProjectConversation(project,body={}){
  const dir=this.ensureProjectDir(project);
  const c=this.service.createConversation(body.title||project.name,body.model||this.service.defaultModel,body.reasoning||'medium',body.accessMode||'danger-full-access',dir,body.codexProfile,project.id);
  c.workspaceProjectId=project.id;
  c.project=project.name;
  c.workDir=dir;
  this.service.writeConversation(c);
  return c;
 }
 validateSchedule(body,previous={},deviceId){const name=String(body.name??previous.name??'').trim(),prompt=String(body.prompt??previous.prompt??'').trim();if(!name||name.length>80||!prompt||prompt.length>8000)throw new Error('请输入计划名称和任务要求');
  const intervalMinutes=Number(body.intervalMinutes??previous.intervalMinutes??0);if(!Number.isInteger(intervalMinutes)||intervalMinutes!==0&&(intervalMinutes<5||intervalMinutes>10080))throw new Error('重复间隔须为 5–10080 分钟');
  const nextAt=String(body.nextAt??previous.nextAt??'');if(!Number.isFinite(Date.parse(nextAt))||(!previous.id&&Date.parse(nextAt)<this.clock()+1000))throw new Error('开始时间须晚于当前时间');
  const projectId=body.projectId??previous.projectId??null;if(projectId&&!this.data.projects.some(x=>x.id===projectId))throw new Error('项目不存在');
  const codexProfile=String(body.codexProfile??previous.codexProfile??this.service.defaultCodexProfile);if(!this.service.allowedCodexProfiles.has(codexProfile))throw new Error('账号不可用');
  const model=String(body.model??previous.model??this.service.defaultModel);if(!this.service.modelAllowed(model,codexProfile))throw new Error('模型不可用');
  if(body.enabled!==undefined&&typeof body.enabled!=='boolean')throw new Error('启用状态无效');
  return {...previous,name,prompt,intervalMinutes,nextAt,projectId,codexProfile,model,ownerDeviceId:previous.ownerDeviceId||deviceId,enabled:body.enabled??previous.enabled??true,runs:previous.runs||[]};
 }
 submit(id,deviceId,body){const response={writeHead(status){this.status=status;},end(json){this.payload=JSON.parse(json);}};this.service.createMessage({},response,id,deviceId,body);return response;}
 publicSchedule(item){const {ownerDeviceId,...value}=item;return value;}
 async fire(item,{manual=false}={}){
  const now=this.clock();const key=manual?'manual-'+crypto.randomUUID():item.nextAt;
  const prior=item.runs.find(run=>run.key===key);if(prior)return prior;
  const run={id:crypto.randomUUID(),key,createdAt:new Date(now).toISOString(),state:'launching'};item.runs.push(run);item.runs=item.runs.slice(-50);
  if(!manual){if(item.intervalMinutes){const interval=item.intervalMinutes*60000;item.nextAt=new Date(Date.parse(item.nextAt)+(Math.floor(Math.max(0,now-Date.parse(item.nextAt))/interval)+1)*interval).toISOString();}else item.enabled=false;}
  // Journal before launching. A crash cannot replay the same occurrence into a new conversation.
  this.save();
  try{
   const project=this.data.projects.find(p=>p.id===item.projectId);
   const previous=item.runs.slice(0,-1).findLast(r=>r.conversationId);
   const previousConversation=previous&&this.service.readConversation(previous.conversationId);
   if(previousConversation?.messages.some(m=>m.role==='assistant'&&['queued','running'].includes(m.status))){run.state='skipped';run.detail='上一次任务尚未结束';this.save();return run;}
   const c=project?this.createProjectConversation(project,{title:item.name,model:item.model,codexProfile:item.codexProfile}):this.service.createConversation(item.name,item.model,'medium','danger-full-access','',item.codexProfile);
   run.conversationId=c.id;this.save();const response=this.submit(c.id,item.ownerDeviceId,{text:item.prompt,clientRequestId:'schedule-'+run.id});
   if(response.status>=400)throw new Error(response.payload.error);run.state='queued';this.save();return run;
  }catch(error){run.state='failed';run.detail=String(error.message).slice(0,180);this.save();return run;}
 }
 async tick(){if(this.ticking)return;this.ticking=true;try{for(const schedule of this.data.schedules){if(schedule.enabled&&Date.parse(schedule.nextAt)<=this.clock())await this.fire(schedule);}}catch{}finally{this.ticking=false;}}
 handle(req,res,url,principal){const s=this.service,deviceId=String(principal.deviceId||'legacy');const reply=(status,payload)=>s.sendJson(res,status,payload);const route=url.pathname;
  if(route==='/chat/notifications'&&req.method==='GET'){const after=Math.max(0,Number(url.searchParams.get('after'))||0);reply(200,{events:this.data.events.filter(e=>e.sequence>after),latestSequence:this.data.sequence});return true;}
  if(route==='/chat/projects'&&req.method==='GET'){
   const metadata=s.store.listMetadata().filter(c=>!c.archived);
   const projects=this.data.projects.map(p=>{
    const convs=metadata.filter(c=>c.workspaceProjectId===p.id);
    const lastUsedAt=convs.reduce((latest,c)=>String(c.updatedAt||'')>latest?String(c.updatedAt||''):latest,p.updatedAt||p.createdAt||'');
    return {...this.publicProject(p),conversationCount:convs.length,lastUsedAt};
   }).sort((a,b)=>String(b.lastUsedAt||'').localeCompare(String(a.lastUsedAt||'')));
   reply(200,{projects});return true;
  }
  if(route==='/chat/schedules'&&req.method==='GET'){reply(200,{schedules:this.data.schedules.map(x=>this.publicSchedule({...x,runs:x.runs.map(run=>{const c=run.conversationId&&s.readConversation(run.conversationId);return c?{...run,taskStatus:s.publicConversation(c,false).taskStatus.state}:run;})}))});return true;}
  const project=route.match(/^\/chat\/projects\/([a-f0-9-]{36})(\/conversations)?$/),projectFile=route.match(/^\/chat\/projects\/([a-f0-9-]{36})\/files(?:\/([a-f0-9-]{36}))?$/),schedule=route.match(/^\/chat\/schedules\/([a-f0-9-]{36})(\/run)?$/),action=route.match(/^\/chat\/conversations\/([a-f0-9-]{36})\/(cancel|retry|artifact-content)$/);
  if(projectFile&&req.method==='POST'&&!projectFile[2]){
   const p=this.data.projects.find(item=>item.id===projectFile[1]);
   if(!p){reply(404,{error:'项目不存在'});return true;}
   const chunks=[];let total=0;const limit=25*1024*1024;let aborted=false;
   let rawName='未命名文件';
   try{rawName=decodeURIComponent(String(req.headers?.['x-file-name']||'未命名文件'));}catch{rawName=String(req.headers?.['x-file-name']||'未命名文件');}
   const mimeType=String(req.headers?.['x-file-type']||'application/octet-stream');
   req.on('data',chunk=>{total+=chunk.length;if(total>limit){aborted=true;reply(413,{error:'单个参考文件不能超过 25 MB'});req.destroy();return;}chunks.push(chunk);});
   req.on('end',()=>{if(aborted)return;try{const ref=this.addReferenceFile(p,rawName,mimeType,Buffer.concat(chunks));reply(201,{reference:ref,project:this.projectPayload(p)});}catch(err){reply(400,{error:String(err.message).slice(0,200)});}});
   req.on('error',()=>{if(!aborted)reply(400,{error:'上传中断，请重试'});});
   return true;
  }
  if(projectFile&&req.method==='DELETE'&&projectFile[2]){
   const p=this.data.projects.find(item=>item.id===projectFile[1]);
   if(!p){reply(404,{error:'项目不存在'});return true;}
   const ok=this.removeReferenceFile(p,projectFile[2]);
   reply(ok?200:404,ok?{ok:true,project:this.projectPayload(p)}:{error:'参考文件不存在'});return true;
  }
  if(project&&!project[2]&&req.method==='GET'){const p=this.data.projects.find(p=>p.id===project[1]);reply(p?200:404,p?{project:this.projectPayload(p)}:{error:'项目不存在'});return true;}
  if(project&&!project[2]&&req.method==='DELETE'){
   const removeFiles=url.searchParams.get('removeFiles')==='1'||url.searchParams.get('removeFiles')==='true';
   const result=this.deleteProject(project[1],{removeFiles});
   reply(result?200:404,result||{error:'项目不存在'});return true;
  }
  // Existing Android clients whitelist this conversation-content route. Keep the
  // normal file preview intact and dispatch the explicit history view to the
  // same validated day-pagination handler used by browsers.
  if(action && action[2] === 'artifact-content' && req.method === 'GET' && url.searchParams.get('view') === 'history') {
    const historyUrl = new URL(url);
    historyUrl.pathname = `/chat/conversations/${action[1]}/messages`;
    historyUrl.searchParams.set('window', '24h');
    return s.handle(req, res, historyUrl, principal);
  }
  if(action&&action[2]==='artifact-content'&&req.method==='GET'){this.artifactContent(res,action[1],url.searchParams.get('messageId'),url.searchParams.get('artifactId'),Number(url.searchParams.get('page'))||1).catch(()=>reply(422,{error:'此文件无法生成预览，请下载查看'}));return true;}
  if(!(route==='/chat/projects'&&req.method==='POST'||route==='/chat/schedules'&&req.method==='POST'||project&&['PATCH','POST'].includes(req.method)||schedule&&['PATCH','POST'].includes(req.method)||action&&['cancel','retry'].includes(action[2])&&req.method==='POST'))return false;
  s.readJsonBody(req,5*1024*1024,async(error,body)=>{if(error){reply(400,{error:error.message});return;}try{
   if(action){reply(200,action[2]==='cancel'?this.cancel(action[1],deviceId):this.retry(action[1],deviceId));return;}
   if(project){
    const p=this.data.projects.find(p=>p.id===project[1]);
    if(!p){reply(404,{error:'项目不存在'});return;}
    if(project[2]){const c=this.createProjectConversation(p,body);reply(201,{conversation:s.publicConversation(c)});return;}
    if(req.method==='PATCH'&&body&&body.deleted===true){
     const result=this.deleteProject(p.id,{removeFiles:Boolean(body.removeFiles)});
     reply(200,result);return;
    }
    if(req.method==='PATCH'&&body&&typeof body.removeReferenceId==='string'){
     const ok=this.removeReferenceFile(p,body.removeReferenceId);
     reply(ok?200:404,ok?{ok:true,project:this.projectPayload(p)}:{error:'参考文件不存在'});return;
    }
    if(req.method==='PATCH'&&body&&body.addReference&&typeof body.addReference==='object'){
     const buf=Buffer.from(String(body.addReference.contentBase64||''),'base64');
     const ref=this.addReferenceFile(p,body.addReference.name,body.addReference.mimeType,buf);
     reply(201,{reference:ref,project:this.projectPayload(p)});return;
    }
    const prevName=p.name;
    const next=this.validateProject(body,p);
    Object.assign(p,next);
    delete p.workDir;
    this.ensureProjectDir(p);
    if(prevName!==p.name)this.syncProjectNameToConversations(p);
    this.save();reply(200,{project:this.projectPayload(p)});return;
   }
   if(schedule){const item=this.data.schedules.find(p=>p.id===schedule[1]);if(!item){reply(404,{error:'计划不存在'});return;}if(schedule[2]){reply(200,{run:await this.fire(item,{manual:true})});return;}const changes=Object.keys(body);if(changes.length===1&&changes[0]==='enabled'){if(typeof body.enabled!=='boolean')throw new Error('启用状态无效');if(body.enabled&&Date.parse(item.nextAt)<=this.clock())throw new Error('请先把开始时间改为未来时间');item.enabled=body.enabled;}else Object.assign(item,this.validateSchedule(body,item,deviceId));this.save();reply(200,{schedule:this.publicSchedule(item)});return;}
   if(route==='/chat/projects'){
    if(this.data.projects.length>=100)throw new Error('项目数量已达上限');
    const now=new Date(this.clock()).toISOString();
    const p={...this.validateProject(body),id:crypto.randomUUID(),createdAt:now,updatedAt:now};
    this.ensureProjectDir(p);
    this.data.projects.push(p);this.save();reply(201,{project:{...this.publicProject(p),conversationCount:0}});
   }
   else{if(this.data.schedules.length>=100)throw new Error('计划数量已达上限');const item={...this.validateSchedule(body,{},deviceId),id:crypto.randomUUID(),createdAt:new Date(this.clock()).toISOString()};this.data.schedules.push(item);this.save();reply(201,{schedule:this.publicSchedule(item)});}
  }catch(error){reply(400,{error:String(error.message).slice(0,200)});}});return true;
 }
 async artifactContent(res,id,messageId,artifactId,page=1){const s=this.service,c=s.readConversation(id),message=c?.messages.find(m=>m.id===messageId),artifact=message?.artifacts?.find(a=>a.id===artifactId);if(!artifact){s.sendJson(res,404,{error:'文件不存在'});return;}
  const verified=s.deliveryArtifact(artifact.sourcePath);if(!verified){s.sendJson(res,410,{error:'文件已移动或不可预览'});return;}
  const text=/\.(txt|md|csv|json|js|ts|tsx|jsx|py|java|kt|dart|css|html|xml|yaml|yml|log|sh|sql|c|h|cpp|rs|go)$/i.test(artifact.name),pdf=/\.pdf$/i.test(artifact.name),image=/^image\//.test(verified.mimeType);
  const limit=text?512*1024:pdf?20*1024*1024:image?10*1024*1024:0;if(!limit){s.sendJson(res,415,{error:'此类型请下载后查看'});return;}if(verified.size>limit){s.sendJson(res,413,{error:'文件较大，请下载后查看'});return;}
  if(pdf){
   const info=await execFile('/usr/bin/pdfinfo',[verified.sourcePath],{timeout:8000,maxBuffer:32768});const pages=Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
   if(!Number.isInteger(page)||page<1||!pages||page>pages){s.sendJson(res,400,{error:'PDF 页码无效'});return;}
   const image=await execFile('/usr/bin/pdftoppm',['-f',String(page),'-l',String(page),'-scale-to','1400','-singlefile','-jpeg',verified.sourcePath],{timeout:15000,maxBuffer:10*1024*1024,encoding:'buffer'});
   s.sendJson(res,200,{name:artifact.name,mimeType:'image/jpeg',kind:'pdf-page',encoding:'base64',content:image.stdout.toString('base64'),size:verified.size,page,pages});return;
  }
  const content=fs.readFileSync(verified.sourcePath);s.sendJson(res,200,{name:artifact.name,mimeType:verified.mimeType,kind:text?'text':pdf?'pdf':'image',encoding:text?'utf8':'base64',content:text?content.toString('utf8'):content.toString('base64'),size:verified.size});
 }
}
module.exports={UserWorkspace};
