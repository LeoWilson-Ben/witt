"use strict";
const fs = require('node:fs');
const OWNER = process.env.STELLARBIT_ALLOWED_USER_ID || '';
function models(scope) {
 if(!OWNER || scope !== OWNER) return [];
 try { return JSON.parse(fs.readFileSync('/var/lib/witt/runtime/stellarbit/verification.json','utf8')).filter(r=>r.ok).map(r=>({id:'stellarbit:'+r.model,displayName:r.model+' · Stellarbit',provider:'stellarbit',isDefault:false,inputModalities:['text'],defaultReasoningEffort:'medium',reasoningEfforts:[{id:'medium',description:'模型默认'}]})); } catch {return [];}
}
module.exports = {models};
