import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({ TextDecoder, TextEncoder, atob, btoa, structuredClone, console, AbortController });
vm.runInContext(fs.readFileSync(new URL('../contracts/openstudio/studio-engine.js',import.meta.url),'utf8'),context);
async function call(input) { const r=JSON.parse(await context.MobileStudio.run(JSON.stringify(input))); assert.equal(r.ok,true,r.error); return r.value; }
const text='Keeper(1234567) 2026/10/02 21:41:06\n夜色笼罩港口。\nHarvey(7654321) 2026/10/02 21:43:45\n我举起提灯。';
const files=[{name:'night.txt',data:Buffer.from(text).toString('base64')}];
test('bundled engine imports logs, strips platform IDs, appends once and restores portable backup',async()=>{
 const {project}=await call({action:'import',files}); assert.equal(project.events.length,2); assert.equal(project.characters.length,2); assert.ok(!JSON.stringify(project).includes('1234567'));
 const appended=await call({action:'import',files,project}); assert.equal(appended.project.events.length,2);
 const backup=await call({action:'archive',project}); const restored=await call({action:'import',files:[{name:'backup.json',data:Buffer.from(backup.text).toString('base64')}]});
 assert.notEqual(restored.project.id,project.id); assert.equal(restored.project.events[0].content,project.events[0].content);
});
test('preview, PDF source and VN are offline and preserve local image data',async()=>{
 const {project}=await call({action:'import',files});
 const path='assets/test.jpg',image='data:image/jpeg;base64,YQ=='; project.characters[1].portrait=path;
 for(const action of ['html','pdf','vn']) { const result=await call({action,project,assets:{[path]:image},language:'zh-CN'}); assert.ok(result.html.includes('夜色')); assert.ok(result.html.includes("connect-src 'none'")); assert.ok(!result.html.includes('StudioNative')); if(action==='pdf'||action==='vn') assert.ok(result.html.includes(image),action); }
});
test('secret messages stay out of every shareable format unless included; backups retain them',async()=>{
 const {project}=await call({action:'import',files}); project.events[0].type='secret'; project.events[0].content='PRIVATE_MARKER';
 for(const action of ['html','pdf','vn','text','native']) { const result=await call({action,project}); assert.ok(!JSON.stringify(result).includes('PRIVATE_MARKER'),action); }
 assert.ok((await call({action:'archive',project})).text.includes('PRIVATE_MARKER'));
 for(const action of ['html','pdf','vn','text','native']) assert.ok(JSON.stringify(await call({action,project,secret:true})).includes('PRIVATE_MARKER'),action);
 project.events[0].type='ooc'; project.events[0].content='OOC_MARKER';
 for(const action of ['html','pdf','vn','text','native']) assert.ok(JSON.stringify(await call({action,project,ooc:true})).includes('OOC_MARKER'),action);
});
test('untrusted paths and markup cannot escape the project or become executable',async()=>{
 const {project}=await call({action:'import',files}); project.events[0].content='<script>EVIL()</script>';
 const html=(await call({action:'html',project})).html; assert.ok(!html.includes('<script>EVIL()'));
 const bad=JSON.parse(await context.MobileStudio.run(JSON.stringify({action:'archive',project,assets:{'../escape.jpg':'data:image/jpeg;base64,YQ=='}}))); assert.equal(bad.ok,false);
});

const config={provider:'openai',model:'fixture-model',endpoint:'https://fixture.invalid/v1'};
const response=(flat)=>({status:200,body:{model:'fixture-model',choices:[{message:{content:JSON.stringify(flat)}}]}});
async function pending(state) { for(let i=0;i<30 && state.state==='running' && !state.request;i++) state=await call({action:'aiPoll',id:state.id}); return state; }
async function send(state,flat) { return pending(await call({action:'aiAnswer',id:state.id,response:response(flat)})); }
const flat=(text='REWRITTEN')=>({generate_backgrounds:[{name:'Harbour',prompt:'night'}],script:[{ref:'L1',background:'Harbour',text}],exclude:[{ref:'L2',reason:'scheduling chatter'}]});
test('AI questions survive backup; answers replay the turn, preserve edits and show exclusion reasons',async()=>{
 let {project}=await call({action:'import',files});
 let state=await pending(await call({action:'aiStart',mode:'compose',project,config,language:'en'}));
 assert.ok(state.request.body.messages[0].content.includes('edit boldly'));
 state=await send(state,{...flat(),questions:[{id:'q1',question:'Was this a bot?',refs:['L1'],options:['Yes','No']}]});
 assert.equal(state.state,'done');project=state.project;assert.ok(project.vn_draft);assert.equal(project.vn,undefined);
 const backup=await call({action:'archive',project});project=(await call({action:'import',files:[{name:'draft.json',data:Buffer.from(backup.text).toString('base64')}]})).project;
 project.vn_draft.pending[0].answers={q1:'No, narration'};
 state=await pending(await call({action:'aiStart',mode:'resume',project,config,language:'en'}));
 assert.equal(state.request.body.messages[2].role,'assistant');assert.ok(state.request.body.messages[3].content.includes('No, narration'));
 state=await send(state,flat());assert.equal(state.state,'done');project=state.project;
 assert.equal(project.vn_draft,undefined);assert.equal(project.events[0].content,'夜色笼罩港口。\n');
 assert.equal(project.vn.script.scenes[0].lines[0].text,'REWRITTEN');assert.equal(project.vn.script.scenes[0].lines[1].exclusion_reason,'scheduling chatter');
 const html=(await call({action:'vn',project})).html;assert.ok(html.includes('REWRITTEN'));assert.ok(!html.includes('scheduling chatter'));
 const extra=[{name:'later.txt',data:Buffer.from('Harvey(7654321) 2026/10/02 21:49:45\nThe door opens.').toString('base64')}];
 project=(await call({action:'import',project,files:extra})).project;
 state=await pending(await call({action:'aiStart',mode:'continue',project,config,language:'en'}));
 state=await send(state,{...flat('CONTINUED'),exclude:[],questions:[{id:'q2',question:'Which door?',refs:['L1'],options:[]}]});
 project=state.project;assert.equal(project.vn_draft.events,3);project.vn_draft.pending[0].skip=true;
 state=await pending(await call({action:'aiStart',mode:'resume',project,config,language:'en'}));assert.equal(state.state,'done');
 assert.ok(JSON.stringify(state.project.vn.script).includes('REWRITTEN'));assert.ok(JSON.stringify(state.project.vn.script).includes('CONTINUED'));
});
test('interrupted multi-part tasks reuse saved answers and reject changed source or service',async()=>{
 const long=Array.from({length:130},(_,i)=>`Ada(1234567) 2026/10/02 21:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}\nline ${i}`).join('\n');
 let {project}=await call({action:'import',files:[{name:'long.txt',data:Buffer.from(long).toString('base64')}]});
 let state=await pending(await call({action:'aiStart',mode:'compose',project,config,language:'en'}));
 state=await send(state,flat());assert.equal(state.state,'running');assert.equal(state.checkpoint.journal.length,1);
 project.mobile_ai_job=state.checkpoint;await call({action:'aiCancel',id:state.id});
 const changed=structuredClone(project);changed.events[0].content='changed';
 const rejected=JSON.parse(await context.MobileStudio.run(JSON.stringify({action:'aiStart',mode:'retry',project:changed,config})));assert.equal(rejected.ok,false);
 state=await pending(await call({action:'aiStart',mode:'retry',project,config}));
 assert.ok(state.request.body.messages[1].content.startsWith('Part 2 of 2'));
 state=await send(state,{generate_backgrounds:[],script:[{ref:'L121',background:'Harbour',text:'SECOND_PART'}]});assert.equal(state.state,'done');assert.equal(state.project.mobile_ai_job,undefined);
});
test('Anthropic signed replay falls back to text on rejection and never replays unsigned reasoning',async()=>{
 let {project}=await call({action:'import',files});const anthropic={...config,provider:'anthropic'};
 let state=await pending(await call({action:'aiStart',mode:'compose',project,config:anthropic,language:'en'}));
 const text=JSON.stringify({...flat(),questions:[{id:'q',question:'Confirm?',refs:[],options:[]}]});
 state=await pending(await call({action:'aiAnswer',id:state.id,response:{status:200,body:{model:config.model,content:[{type:'thinking',thinking:'sealed',signature:'signature'},{type:'text',text}]}}}));
 project=state.project;project.vn_draft.pending[0].answers={q:'Yes'};
 state=await pending(await call({action:'aiStart',mode:'resume',project,config:anthropic,language:'en'}));assert.equal(state.request.retryPlain,true);
 state=await pending(await call({action:'aiAnswer',id:state.id,response:{status:400,body:{}}}));assert.equal(state.request.retryPlain,false);assert.equal(typeof state.request.body.messages[1].content,'string');
 state=await pending(await call({action:'aiAnswer',id:state.id,response:{status:200,body:{model:config.model,content:[{type:'text',text:JSON.stringify(flat())}]}}}));assert.equal(state.state,'done');
});

test('saved AI rewrites cannot silently export private context through a public VN',async()=>{
 const {project}=await call({action:'import',files});project.events[0].type='secret';
 let state=await pending(await call({action:'aiStart',mode:'compose',project,config,language:'en'}));state=await send(state,flat('PRIVATE REWRITE'));
 const rejected=JSON.parse(await context.MobileStudio.run(JSON.stringify({action:'vn',project:state.project})));assert.equal(rejected.ok,false);
 assert.ok((await call({action:'vn',project:state.project,secret:true})).html.includes('PRIVATE REWRITE'));
});
