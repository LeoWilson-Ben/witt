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
 projectFor(conversation){return this.data.projects.find(item=>item.id===conversation.workspaceProjectId)||null;}
 canonicalDirectory(conversation){try{return fs.realpathSync(this.service.effectiveWorkDir(conversation));}catch{return path.resolve(this.service.effectiveWorkDir(conversation));}}
 conflict(conversation){
  if(conversation.accessMode==='read-only')return null;
  const directory=this.canonicalDirectory(conversation);
  for(const active of this.service.activeTurns.values()){
   if(active.conversationId===conversation.id)continue;
   const other=this.service.readConversation(active.conversationId);
   if(!other||other.accessMode==='read-only')continue;
   if(conversation.workspaceProjectId&&conversation.workspaceProjectId===other.workspaceProjectId)return {conversationId:other.id,title:other.title};
   const otherDir=this.canonicalDirectory(other);
   // The shared home is a landing directory, not a single source project.
   if(directory==='/home/ubuntu'||otherDir==='/home/ubuntu')continue;
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
 projectPayload(project){const conversations=this.service.store.listMetadata().filter(c=>!c.archived&&c.workspaceProjectId===project.id).map(c=>this.service.publicConversation(c,false));const files=[];
  for(const meta of conversations){const c=this.service.readConversation(meta.id);for(const m of c.messages||[])for(const a of m.artifacts||[])files.push({id:a.id,messageId:m.id,conversationId:c.id,name:a.name,size:a.size,mimeType:a.mimeType,createdAt:m.completedAt||m.createdAt});}
  return {...project,conversations,files:files.slice(-100).reverse()};
 }
 validateProject(body,previous={}){const name=String(body.name??previous.name??'').trim();if(!name||name.length>80)throw new Error('项目名称须为 1–80 个字符');const instructions=String(body.instructions??previous.instructions??'');if(instructions.length>12000)throw new Error('项目说明过长');
  const shortcuts=body.shortcuts??previous.shortcuts??[];if(!Array.isArray(shortcuts)||shortcuts.length>12||shortcuts.some(x=>typeof x.name!=='string'||!x.name.trim()||x.name.length>40||typeof x.prompt!=='string'||!x.prompt.trim()||x.prompt.length>4000))throw new Error('常用指令格式无效');
  const workDir=this.service.normalizeWorkDir(body.workDir??previous.workDir??'')||'';return {...previous,name,instructions,shortcuts,workDir};
 }
 createProjectConversation(project,body={}){const c=this.service.createConversation(body.title||project.name,body.model||this.service.defaultModel,body.reasoning||'medium',body.accessMode||'danger-full-access',project.workDir,body.codexProfile);c.workspaceProjectId=project.id;c.project=project.name;this.service.writeConversation(c);return c;}
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
  if(route==='/chat/projects'&&req.method==='GET'){reply(200,{projects:this.data.projects.map(p=>({...p,conversationCount:s.store.listMetadata().filter(c=>!c.archived&&c.workspaceProjectId===p.id).length}))});return true;}
  if(route==='/chat/schedules'&&req.method==='GET'){reply(200,{schedules:this.data.schedules.map(x=>this.publicSchedule({...x,runs:x.runs.map(run=>{const c=run.conversationId&&s.readConversation(run.conversationId);return c?{...run,taskStatus:s.publicConversation(c,false).taskStatus.state}:run;})}))});return true;}
  const project=route.match(/^\/chat\/projects\/([a-f0-9-]{36})(\/conversations)?$/),schedule=route.match(/^\/chat\/schedules\/([a-f0-9-]{36})(\/run)?$/),action=route.match(/^\/chat\/conversations\/([a-f0-9-]{36})\/(cancel|retry|artifact-content)$/);
  if(project&&req.method==='GET'){const p=this.data.projects.find(p=>p.id===project[1]);reply(p?200:404,p?{project:this.projectPayload(p)}:{error:'项目不存在'});return true;}
  if(action&&action[2]==='artifact-content'&&req.method==='GET'){this.artifactContent(res,action[1],url.searchParams.get('messageId'),url.searchParams.get('artifactId'),Number(url.searchParams.get('page'))||1).catch(()=>reply(422,{error:'此文件无法生成预览，请下载查看'}));return true;}
  if(!(route==='/chat/projects'&&req.method==='POST'||route==='/chat/schedules'&&req.method==='POST'||project&&['PATCH','POST'].includes(req.method)||schedule&&['PATCH','POST'].includes(req.method)||action&&['cancel','retry'].includes(action[2])&&req.method==='POST'))return false;
  s.readJsonBody(req,32*1024,async(error,body)=>{if(error){reply(400,{error:error.message});return;}try{
   if(action){reply(200,action[2]==='cancel'?this.cancel(action[1],deviceId):this.retry(action[1],deviceId));return;}
   if(project){const p=this.data.projects.find(p=>p.id===project[1]);if(!p){reply(404,{error:'项目不存在'});return;}if(project[2]){const c=this.createProjectConversation(p,body);reply(201,{conversation:s.publicConversation(c)});return;}Object.assign(p,this.validateProject(body,p));this.save();reply(200,{project:this.projectPayload(p)});return;}
   if(schedule){const item=this.data.schedules.find(p=>p.id===schedule[1]);if(!item){reply(404,{error:'计划不存在'});return;}if(schedule[2]){reply(200,{run:await this.fire(item,{manual:true})});return;}const changes=Object.keys(body);if(changes.length===1&&changes[0]==='enabled'){if(typeof body.enabled!=='boolean')throw new Error('启用状态无效');if(body.enabled&&Date.parse(item.nextAt)<=this.clock())throw new Error('请先把开始时间改为未来时间');item.enabled=body.enabled;}else Object.assign(item,this.validateSchedule(body,item,deviceId));this.save();reply(200,{schedule:this.publicSchedule(item)});return;}
   if(route==='/chat/projects'){if(this.data.projects.length>=100)throw new Error('项目数量已达上限');const p={...this.validateProject(body),id:crypto.randomUUID(),createdAt:new Date(this.clock()).toISOString()};this.data.projects.push(p);this.save();reply(201,{project:p});}
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
