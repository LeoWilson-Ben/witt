"use strict";
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');const {EventEmitter}=require('node:events');const readline=require('node:readline');
const EFFORTS=['low','medium','high','xhigh','max'];
const labels={low:'快速',medium:'均衡',high:'深入',xhigh:'极致',max:'巅峰'};
const efforts=ids=>ids.map(id=>({id,label:labels[id],description:labels[id]}));
// Classify private CLI diagnostics without returning their raw content.
function cliFailureMessage(value){
 const text=typeof value==='string'?value:'';
 if(/not (?:currently )?available in your (?:location|region|country)|not eligible.*(?:location|region|country)|unsupported (?:location|region|country)/i.test(text))return 'Antigravity 拒绝当前账号的地区资格：所在地区暂不受支持。登录成功不代表具备模型使用资格，请检查官方账号可用地区。';
 if(/eligibility check failed|not eligible/i.test(text))return '当前账号未通过 Antigravity 使用资格检查，请在官方页面确认账号资格。';
 if(/unauthenticated|authentication required|not (?:signed|logged) in|invalid_grant|expired.*token/i.test(text))return '该账号的授权已失效，请在账号管理中重新登录。';
 if(/quota|resource_exhausted|rate.?limit|too many requests/i.test(text))return '该账号额度已用尽或请求受限，请稍后重试或检查官方额度。';
 if(/model.*(?:not found|not available|unsupported)|unknown model/i.test(text))return '当前账号无法使用此模型，请刷新模型列表后重新选择。';
 return '';
}

class ProviderRuntime{
 constructor(options){this.owner=options.owner;this.services=options.services;this.spawn=options.spawn||spawn;this.clients=new Map();}
 service(provider){const service=this.services[provider];if(!service)throw Error('账号类型不可用');return service;}
 env(provider){return this.service(provider).env(this.owner);}
 home(provider){const env=this.env(provider);return provider==='claude'?env.CLAUDE_CONFIG_DIR:env.HOME;}
 provider(profile){return profile?.provider||null;}
 models(provider){
  if(provider==='claude')return ['sonnet','opus','haiku'].map((name,i)=>({id:'claude:'+name,model:'claude:'+name,displayName:'Claude '+name[0].toUpperCase()+name.slice(1),description:i===0?'日常编程与分析':i===1?'复杂推理与长任务':'快速处理轻量任务',isDefault:i===0,reasoningEfforts:efforts(name==='haiku'?['low','medium','high']:EFFORTS),defaultReasoningEffort:'medium'}));
  let rows=this.service(provider).modelCache.get(this.owner)?.models;
  if(!rows)try{rows=JSON.parse(fs.readFileSync(path.join(this.home(provider),'witt-models.json'),'utf8'));}catch{rows=[];}
  const groups=new Map();for(const row of rows||[]){if(!/^(?:gemini|claude|gpt)-[a-zA-Z0-9._-]+$/.test(row.slug||''))continue;const m=row.slug.match(/^(.*)-(low|medium|high|xhigh|max)$/),base=m?m[1]:row.slug,level=m?m[2]:'medium';const g=groups.get(base)||{id:'gemini:'+base,model:'gemini:'+base,displayName:String(row.name||base).replace(/\s*\((Low|Medium|High|Max)\)\s*$/i,''),description:'通过 Antigravity CLI',variants:{}};g.variants[level]=row.slug;groups.set(base,g);}
  const result=[...groups.values()].map(g=>({...g,displayName:g.displayName.replace(/\s*\((?:Low|Medium|High|XHigh|Max)\)\s*$/i,''),reasoningEfforts:efforts(EFFORTS.filter(e=>g.variants[e])),defaultReasoningEffort:g.variants.medium?'medium':Object.keys(g.variants)[0]}));
  if(result.length){const primary=result.find(m=>/3\.8.*flash/i.test(m.id))||result[0];primary.isDefault=true;}return result;
 }
 defaultModel(provider){return this.models(provider).find(m=>m.isDefault)?.id||this.models(provider)[0]?.id||'';}
 allowed(model,profile){return this.models(profile.provider).some(m=>m.id===model);}
 reasoning(model,profile,requested){const item=this.models(profile.provider).find(m=>m.id===model);return item?.reasoningEfforts.some(e=>e.id===requested)?requested:item?.defaultReasoningEffort||'medium';}
 async capabilities(profile){try{if(profile.provider==='antigravity'&&(await this.service('antigravity').account(this.owner)).authenticated)await this.service('antigravity').availableModels(this.owner);
  }catch{/* Retain the last discovered models when account refresh is unavailable. */}
  return {codexProfile:profile.id,provider:profile.provider,models:this.models(profile.provider),skills:[],mcpServers:[],features:[],collaborationModes:[],support:{fork:false,compact:false,review:false,plans:true},checkedAt:new Date().toISOString()};}
 async usage(profile){return {provider:profile.provider,codexProfile:profile.id,rateLimits:null,quota:profile.provider==='antigravity'?await this.service('antigravity').quota(this.owner):{available:false,groups:[],message:'此账号暂未提供可读取的额度数据'}};}
 client(profile){let client=this.clients.get(profile.id);if(!client){client=new CliAgentClient(this,profile);this.clients.set(profile.id,client);}return client;}
}
class CliAgentClient extends EventEmitter{
 constructor(runtime,profile){super();this.runtime=runtime;this.profile=profile;this.provider=profile.provider;this.closed=false;this.sessions=new Map();this.runs=new Map();this.setMaxListeners(0);}
 async start(){}
 sessionDir(){const dir=path.join(this.runtime.home(this.provider),'witt-sessions');fs.mkdirSync(dir,{recursive:true,mode:0o700});return dir;}
 loadSession(id){if(!/^[a-f0-9-]{36}$/.test(id||''))throw Error('会话编号无效');let s=this.sessions.get(id);if(!s){try{s=JSON.parse(fs.readFileSync(path.join(this.sessionDir(),id+'.json'),'utf8'));}catch{throw Error('这个账号的会话上下文不可用，请新建对话');}this.sessions.set(id,s);}return s;}
 saveSession(s){fs.writeFileSync(path.join(this.sessionDir(),s.id+'.json'),JSON.stringify(s),{mode:0o600});}
 contextWindowFor(modelId){
  const name=String(modelId||'').toLowerCase();
  if(name.includes('gemini'))return 1000000;
  if(name.includes('claude'))return 200000;
  if(name.includes('gpt'))return 128000;
  return 200000;
 }
 async request(method,args={}){
  if(method==='thread/start'){const id=crypto.randomUUID(),s={id,cwd:args.cwd,instructions:args.developerInstructions||'',nativeSession:null,sandbox:args.sandbox,mcpConfigPath:args.mcpConfigPath||null};this.sessions.set(id,s);this.saveSession(s);return {thread:{id}};}
  if(method==='thread/resume'){const s=this.loadSession(args.threadId);s.cwd=args.cwd||s.cwd;s.instructions=args.developerInstructions||s.instructions;s.sandbox=args.sandbox||s.sandbox;if(args.mcpConfigPath!==undefined)s.mcpConfigPath=args.mcpConfigPath;return {thread:{id:s.id}};}
  if(method==='turn/start'){
   if(!(await this.runtime.service(this.provider).account(this.runtime.owner)).authenticated)throw Error('请先登录对应账号');
   if(!this.runtime.allowed(args.model,this.profile))throw Error('该账号的模型不可用，请刷新模型列表');
   const id=crypto.randomUUID(),s=this.loadSession(args.threadId),run={id,threadId:s.id,session:s,args,stopped:false,settled:false,pending:[],part:0,expectedResults:0,completedResults:0,stdinOpen:false,stepTexts:new Map(),lastMessageItemId:null,lastMessageText:''};this.runs.set(id,run);
   setImmediate(()=>this.launch(run,args.input));return {turn:{id}};
  }
  if(method==='turn/interrupt'){const run=this.runs.get(args.turnId)||[...this.runs.values()].find(r=>r.threadId===args.threadId);if(run){run.stopped=true;run.stdinOpen=false;this.kill(run);this.finish(run,'interrupted','');}return {};}
  if(method==='turn/steer'){
   const run=[...this.runs.values()].find(r=>r.threadId===args.threadId&&!r.settled&&!r.stopped);
   if(!run)throw Error('no active turn');
   if(this.provider==='antigravity'){
    if(!run.stdinOpen||!run.child?.stdin?.writable)throw Error('no active turn');
    const content=this.inputText(args.input);
    if(!content)return {};
    run.expectedResults+=1;
    run.child.stdin.write(JSON.stringify({event:'user',message:{content}})+'\n');
    return {};
   }
   run.pending.push(args.input);return {};
  }
  if(method==='skills/list'||method==='mcpServerStatus/list'||method==='experimentalFeature/list')return {data:[]};
  if(method==='model/list')return {data:this.runtime.models(this.provider)};
  if(method==='collaborationMode/list')return {data:[]};
  throw Error('这个账号暂不支持此操作');
 }
 notify(run,method,data){this.emit('notification',method,{threadId:run.threadId,turnId:run.id,...data});}
 inputText(input){return (input||[]).map(item=>item.type==='text'?item.text:item.type==='localImage'?`附件图片：${item.path}`:'').filter(Boolean).join('\n');}
 launch(run,input){
  if(run.stopped||run.settled)return;
  const service=this.runtime.service(this.provider),model=this.runtime.models(this.provider).find(m=>m.id===run.args.model),effort=this.runtime.reasoning(run.args.model,this.profile,run.args.effort),env=this.runtime.env(this.provider),s=run.session;
  const prompt=this.inputText(input),args=[];
  if(this.provider==='claude'){
   args.push('-p','--output-format','stream-json','--verbose','--include-partial-messages','--model',model.id.slice('claude:'.length),'--effort',effort);
   if(s.nativeSession)args.push('--resume',s.nativeSession);else args.push('--session-id',s.id);
   if(s.mcpConfigPath)args.push('--mcp-config',s.mcpConfigPath);
   if(s.instructions)args.push('--append-system-prompt',s.instructions);
   if((run.args.sandbox||s.sandbox)==='read-only')args.push('--permission-mode','plan');else if((run.args.sandbox||s.sandbox)==='danger-full-access')args.push('--dangerously-skip-permissions');else args.push('--permission-mode','acceptEdits');
  }else{
   const variantSlug=model.variants[effort]||Object.values(model.variants||{})[0]||model.id.replace(/^gemini:/,'');
   args.push('--input-format','stream-json','--output-format','stream-json','--model',variantSlug,'--log-file','/dev/null');
   if(/-(?:low|medium|high|xhigh|max)$/.test(variantSlug))args.push('--effort',effort);
   if(s.nativeSession)args.push('--conversation',s.nativeSession);
   if((run.args.sandbox||s.sandbox)==='read-only')args.push('--mode','plan');else if((run.args.sandbox||s.sandbox)==='danger-full-access')args.push('--dangerously-skip-permissions');else args.push('--mode','accept-edits','--sandbox');
  }
  const text=this.provider==='antigravity'&&!s.nativeSession&&s.instructions?s.instructions+'\n\n'+prompt:prompt;
  const child=this.runtime.spawn(service.bin,args,{cwd:s.cwd,env,detached:true,stdio:['pipe','pipe','pipe']});run.child=child;run.part++;run.itemId=`${run.id}-message-${run.part}`;run.text='';run.result=null;run.failed=false;run.failureMessage='';run.diagnostics='';
  if(run.part===1)this.notify(run,'turn/started',{turn:{id:run.id}});
  const lines=readline.createInterface({input:child.stdout,crlfDelay:Infinity});
  lines.on('line',line=>{if(run.stopped||run.settled||line.length>4*1024*1024)return;try{this.event(run,JSON.parse(line));}catch{}});
  child.stderr.on('data',chunk=>{if(run.settled)return;run.diagnostics=(run.diagnostics+chunk.toString()).slice(-8192);run.failureMessage=run.failureMessage||cliFailureMessage(run.diagnostics);});child.stdin.on('error',()=>{run.stdinOpen=false;});
  child.on('error',()=>{run.stdinOpen=false;if(!run.stopped)this.finish(run,'failed','无法启动对应 CLI，请检查安装与登录状态');});
  child.on('close',code=>{
   run.stdinOpen=false;
   if(run.stopped||run.settled)return;
   if(run.pending.length&&code===0&&!run.failed){const next=run.pending.splice(0).flat();setImmediate(()=>this.launch(run,next));return;}
   const finalText=run.result||run.lastMessageText||run.text;
   if(code===0&&!run.failed&&finalText)this.finish(run,'completed',finalText,run.lastMessageItemId||run.itemId);
   else this.finish(run,'failed',run.failureMessage||'执行未完成，请检查该账号的登录状态、模型访问权限或额度');
  });
  if(this.provider==='antigravity'){
   run.expectedResults=1;run.completedResults=0;run.stdinOpen=true;
   child.stdin.write(JSON.stringify({event:'user',message:{content:text}})+'\n');
  }else child.stdin.end(text);
 }
 emitUsage(run,usage){
  if(!usage||typeof usage!=='object')return;
  const inputTokens=Math.max(0,Number(usage.input_tokens||0)+Number(usage.cache_read_tokens||0));
  const totalTokens=Math.max(0,Number(usage.total_tokens||0));
  if(!inputTokens&&!totalTokens)return;
  this.notify(run,'thread/tokenUsage/updated',{
   tokenUsage:{
    modelContextWindow:this.contextWindowFor(run.args.model),
    last:{inputTokens},
    total:{totalTokens},
   },
  });
 }
 mapAntigravityTool(run,step){
  const done=step.state==='DONE';
  const method=done?'item/completed':'item/started';
  const itemId=`${run.id}-tool-${step.step_index}`;
  const info=step.tool_info||{};
  const name=String(step.tool_name||info.name||'工具执行');
  const params=info.parameters&&typeof info.parameters==='object'?info.parameters:{};
  const output=typeof info.output==='string'?info.output:'';
  const errText=info.error?(typeof info.error==='string'?info.error:String(info.error.message||info.error.type||'执行失败')):'';
  const durationMs=typeof step.duration_seconds==='number'&&Number.isFinite(step.duration_seconds)?Math.round(step.duration_seconds*1000):null;

  if(name==='update_steps'){
   const rawSteps=Array.isArray(params.steps)?params.steps:[];
   const statusMap={done:'completed',completed:'completed',in_progress:'in_progress',pending:'pending',failed:'failed',skipped:'completed'};
   const plan=rawSteps.map(s=>({step:String(s?.title||s?.step||''),status:statusMap[String(s?.status||'pending').toLowerCase()]||'pending'})).filter(s=>s.step);
   this.notify(run,'turn/plan/updated',{plan,explanation:''});
   return;
  }
  if(name==='run_command'||name==='send_command_input'||name==='command_status'){
   const cmd=String(params.CommandLine||params.command||params.Input||name);
   let exitCode=null;
   if(done){
    if(errText)exitCode=1;
    else{const m=output.match(/Command exited with code (\d+)/);exitCode=m?Number(m[1]):0;}
   }
   const aggregatedOutput=errText?(output?`${output}\n${errText}`:errText):output;
   this.notify(run,method,{item:{id:itemId,type:'commandExecution',command:cmd,cwd:String(params.Cwd||run.session.cwd||''),aggregatedOutput,exitCode,durationMs}});
   return;
  }
  if(['write_to_file','write_file','replace_file_content','multi_replace_file_content','edit_file','sed_file','notebook_edit'].includes(name)){
   const filePath=String(params.TargetFile||params.Path||params.FilePath||params.file_path||'');
   const kindType=(name==='write_to_file'||name==='write_file')?'create':'update';
   const diff=String(output||params.ReplacementContent||params.Replacement||'').slice(0,64*1024);
   const changes=filePath?[{path:filePath,kind:{type:kindType},diff}]:[];
   this.notify(run,method,{item:{id:itemId,type:'fileChange',changes}});
   return;
  }
  if(name==='search_web'||name==='read_url_content'){
   const query=String(params.query||params.Query||params.Url||params.url||name).slice(0,200);
   this.notify(run,method,{item:{id:itemId,type:'webSearch',query}});
   return;
  }
  if(['invoke_subagent','manage_subagents','run_workflow','browser_subagent','swarm'].includes(name)){
   const tool=name==='invoke_subagent'||name==='browser_subagent'?'spawn_agent':name;
   this.notify(run,method,{item:{id:itemId,type:'collabToolCall',tool,agentStatus:done?'completed':'running'}});
   return;
  }
  if(name==='generate_image'&&done){
   const match=output.match(/(\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp|gif))/i);
   if(match){
    this.notify(run,'item/completed',{item:{id:itemId,type:'imageGeneration',savedPath:match[1]}});
    return;
   }
  }
  let label=name;
  if(name==='read_file'||name==='view_file'){const p=String(params.Path||params.AbsolutePath||params.file_path||'');label=p?`读取 ${path.basename(p)}`:'读取文件';}
  else if(name==='grep_search'){const q=String(params.Query||params.query||'').slice(0,40);label=q?`搜索 ${q}`:'代码搜索';}
  else if(name==='find_by_name'){const p=String(params.Pattern||params.pattern||'').slice(0,40);label=p?`查找 ${p}`:'查找文件';}
  else if(name==='list_dir'){const d=String(params.DirectoryPath||'');label=d?`查看目录 ${path.basename(d)||d}`:'查看目录';}
  this.notify(run,method,{item:{id:itemId,type:'dynamicToolCall',tool:label}});
 }
 event(run,event){
  const s=run.session;
  const native=event.session_id||event.conversation_id||event.result?.conversation_id||event.step_update?.conversation_id;
  if(native&&/^[a-f0-9-]{36}$/i.test(native)){s.nativeSession=native;this.saveSession(s);}
  if(this.provider==='claude'){
   if(event.type==='stream_event'){
    const delta=event.event?.delta;if(delta?.type==='text_delta')this.delta(run,delta.text||'');
    const block=event.event?.content_block;if(block?.type==='tool_use')this.tool(run,block.id,block.name,false);
    if(event.event?.type==='content_block_stop'){};
   }
   if(event.type==='assistant')for(const block of event.message?.content||[]){if(block.type==='text'&&!run.text)this.delta(run,block.text||'');if(block.type==='tool_use')this.tool(run,block.id,block.name,false);}
   if(event.type==='user')for(const block of event.message?.content||[])if(block.type==='tool_result')this.tool(run,block.tool_use_id,'工具执行',true);
   if(event.type==='result'){run.failed=Boolean(event.is_error);run.result=typeof event.result==='string'?event.result:run.text;}
  }else{
   if(event.event==='step_update'){
    const step=event.step_update||{};
    if(step.usage)this.emitUsage(run,step.usage);
    if(step.step_type==='agent_response'){
     const itemId=`${run.id}-step-${step.step_index??run.part}`;
     if(step.text_delta){
      const nextText=(run.stepTexts.get(itemId)||'')+String(step.text_delta);
      run.stepTexts.set(itemId,nextText);
      run.text=nextText;run.lastMessageItemId=itemId;run.lastMessageText=nextText;
      this.notify(run,'item/agentMessage/delta',{itemId,delta:String(step.text_delta)});
     }
     if(step.state==='DONE'){
      const stepText=run.stepTexts.get(itemId)||'';
      if(stepText.trim()){
       run.lastMessageItemId=itemId;run.lastMessageText=stepText;
       this.notify(run,'item/completed',{item:{id:itemId,type:'agentMessage',text:stepText,phase:'commentary'}});
      }
     }
    }
    if(step.step_type==='tool')this.mapAntigravityTool(run,step);
   }
   if(event.event==='result'){
    const res=event.result||{};
    if(res.usage)this.emitUsage(run,res.usage);
    run.completedResults+=1;
    const status=String(res.status||'').toUpperCase();
    if(status==='INTERRUPTED'||status==='CANCELED'){
     run.stdinOpen=false;try{run.child?.stdin?.end();}catch{}
     this.finish(run,'interrupted','');
     return;
    }
    if(status!=='SUCCESS'){
     run.failed=true;
     run.failureMessage=cliFailureMessage(res.error)||(res.error?String(res.error).slice(0,300):'')||run.failureMessage;
     run.stdinOpen=false;try{run.child?.stdin?.end();}catch{}
     return;
    }
    const finalText=typeof res.response==='string'&&res.response.trim()?res.response:(run.lastMessageText||run.text);
    run.result=finalText;
    if(run.completedResults>=run.expectedResults){
     run.stdinOpen=false;try{run.child?.stdin?.end();}catch{}
     this.finish(run,'completed',finalText,run.lastMessageItemId||`${run.id}-final`);
    }
   }
  }
 }
 delta(run,text){run.text+=text;this.notify(run,'item/agentMessage/delta',{itemId:run.itemId,delta:text});}
 tool(run,id,name,done){this.notify(run,done?'item/completed':'item/started',{item:{id:String(id||crypto.randomUUID()),type:'commandExecution',command:String(name||'工具执行').slice(0,100),aggregatedOutput:'',exitCode:done?0:null}});}
 finish(run,status,text,itemId=run.itemId){if(run.settled)return;run.settled=true;run.stdinOpen=false;run.diagnostics='';this.runs.delete(run.id);
  if(status==='completed')this.notify(run,'item/completed',{item:{id:itemId,type:'agentMessage',text,phase:'final_answer'}});
  this.notify(run,'turn/completed',{turn:{id:run.id,status,error:status==='failed'?{message:text}:undefined}});
 }
 kill(run){if(!run.child)return;try{process.kill(-run.child.pid,'SIGTERM');}catch{run.child.kill();}const timer=setTimeout(()=>{try{process.kill(-run.child.pid,'SIGKILL');}catch{}},1500);timer.unref?.();}
 close(){for(const run of this.runs.values()){run.stopped=true;run.stdinOpen=false;this.kill(run);}this.runs.clear();this.closed=true;}
 respond(){}
}
module.exports={ProviderRuntime,CliAgentClient,cliFailureMessage};
