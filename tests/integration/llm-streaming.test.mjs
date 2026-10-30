import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
const base=process.env.API_BASE||'http://127.0.0.1:18087';
async function call(token,method,path,body){const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});const data=await r.json();if(!r.ok)throw Object.assign(Error(JSON.stringify(data)),{status:r.status});return data;}
async function until(fn){for(let n=0;n<100;n++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw Error('timed out');}
const userText=b=>{const m=(b.input??b.messages).find(m=>m.role==='user').content;return typeof m==='string'?m:m.map(x=>x.text||'').join('');};
test('streaming KP builds run off network threads, deduplicate, report progress, preserve old knowledge on stream errors',async(t)=>{
 let release,hold=true,holdAll=false,broken=false,timeoutNodes=0;const releases=[];const calls=[];
 const fixture=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);assert.equal(body.stream,true);
  const context=JSON.parse(userText(body));const isBuild=Array.isArray(context.nodes);
  if(isBuild){calls.push(context);if(holdAll)await new Promise(r=>releases.push(r));if(hold){hold=false;await new Promise(r=>{release=r;});}}
  if(isBuild&&timeoutNodes&&context.nodes.length>timeoutNodes){res.writeHead(504,{'Retry-After':'0'});return res.end('{}');}
  const cut=broken&&(!isBuild||calls.length>1);
  const data=isBuild?{entries:context.nodes.map(n=>({kind:'background',title:n.name,body:n.description,node_keys:[n.key],citations:n.citations}))}:{summary:'Fixture summary'};
  const content=JSON.stringify(data),half=Math.floor(content.length/2);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=value=>res.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
  if(req.url.endsWith('/messages')){
   send({type:'message_start',message:{type:'message',usage:{input_tokens:5,output_tokens:0}}});
   send({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
   for(const part of [content.slice(0,half),content.slice(half)])send({type:'content_block_delta',index:0,delta:{type:'text_delta',text:part}});
   if(!cut){send({type:'content_block_stop',index:0});send({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:10}});send({type:'message_stop'});}
  }else{
   // OpenAI Responses API: text deltas, the finished item, then the terminal event with the whole response.
   assert.ok(req.url.endsWith('/responses'));assert.equal(body.store,false);
   send({type:'response.created',response:{status:'in_progress',output:[]}});
   for(const part of [content.slice(0,half),content.slice(half)])send({type:'response.output_text.delta',output_index:0,delta:part});
   if(!cut){const item={type:'message',role:'assistant',content:[{type:'output_text',text:content}]};send({type:'response.output_item.done',output_index:0,item});send({type:'response.completed',response:{status:'completed',output:[item],usage:{input_tokens:5,output_tokens:10}}});}
  }
  res.end();
 });
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));t.after(()=>{release?.();for(const r of releases)r();fixture.closeAllConnections();fixture.close();});
 const suffix=Math.random().toString(36).slice(2);
 const gm=(await call('','POST','/api/auth/register',{username:'stream'+suffix,password:'password'})).token;
 const pl=(await call('','POST','/api/auth/register',{username:'reader'+suffix,password:'password'})).token;
 const server=await call(gm,'POST','/api/servers',{name:'Streaming fixture'});
 const channel=(await call(gm,'POST',`/api/servers/${server.id}/channels`,{name:'One network thread'})).id;
 await call(gm,'POST',`/api/channels/${channel}/members`,{username:'reader'+suffix,role:'player'});
 const root=`/api/channels/${channel}`;
 const imported=await call(gm,'POST',root+'/modules/text',{text:Array.from({length:14},(_,i)=>`Location: Library ${i}\nA room with a sealed letter ${i}.`).join('\n')});
 assert.equal(imported.status,'ready');assert.ok(imported.nodes.length>6);
 const second=await call(gm,'POST',root+'/modules/text',{text:'Location: Second library\nA different room with a desk.'});
 const third=await call(gm,'POST',root+'/modules/text',{text:'Location: Third library\nA sealed vault.'});
 const character=await call(gm,'POST',root+'/characters',{name:'Concurrent save'});
 for(const provider of ['openai_compatible','anthropic']){
  await call(gm,'PUT',`/api/servers/${server.id}/settings`,{llm:{provider,api_base:`http://127.0.0.1:${fixture.address().port}/v1`,api_key:'fixture',model:'fixture'}});
  hold=true;release=undefined;calls.length=0;
  const job=await call(gm,'POST',root+'/script-knowledge/rebuild',{module_id:imported.id,async:true});assert.equal(job.status,'pending');
  await until(()=>release);
  const begun=Date.now();
  const ordinary=await Promise.all([call(gm,'GET','/api/health'),call(gm,'GET',root+'/characters'),call(gm,'GET',root+'/script-knowledge/builds')]);
  assert.equal(ordinary[0].status,'ok');assert.ok(Date.now()-begun<2000,'blocked model must not block the only network thread');
  assert.equal((await call(gm,'POST',root+'/script-knowledge/rebuild',{module_id:imported.id,async:true})).id,job.id);
  await assert.rejects(call(pl,'GET',root+'/script-knowledge/builds'),e=>e.status===403);
  release();
  const done=await until(async()=>{const j=(await call(gm,'GET',root+'/script-knowledge/builds'))[0];assert.notEqual(j.status,'failed',j.error);return j.status==='completed'&&j;});
  assert.equal(done.completed_batches,done.total_batches);assert.ok(done.total_batches>1);assert.ok(calls.every(c=>c.nodes.length<=6));
  assert.equal(new Set(calls.flatMap(c=>c.nodes.map(n=>n.key))).size,imported.nodes.length);
  const before=await call(gm,'GET',root+'/script-knowledge');
  broken=true;calls.length=0;
  await call(gm,'POST',root+'/script-knowledge/rebuild',{module_id:imported.id,async:true});
  await until(async()=>{const j=(await call(gm,'GET',root+'/script-knowledge/builds'))[0];return j.status==='failed'&&j;});
  assert.deepEqual(await call(gm,'GET',root+'/script-knowledge'),before,'interrupted SSE must not replace prior knowledge');broken=false;
  timeoutNodes=2;calls.length=0;
  await call(gm,'POST',root+'/script-knowledge/rebuild',{module_id:imported.id,async:true});
  const adapted=await until(async()=>{const j=(await call(gm,'GET',root+'/script-knowledge/builds'))[0];assert.notEqual(j.status,'failed',j.error);return j.status==='completed'&&j;});
  assert.ok(adapted.total_batches>done.total_batches);assert.equal(adapted.completed_batches,adapted.total_batches);
  assert.equal(new Set(calls.filter(c=>c.nodes.length<=2).flatMap(c=>c.nodes.map(n=>n.key))).size,imported.nodes.length);timeoutNodes=0;
  // Legacy callers remain synchronous, but the stalled provider is on an AI worker.
  hold=true;release=undefined;
  const legacy=call(gm,'POST',root+'/script-knowledge/rebuild',{module_id:imported.id});
  await until(()=>release);assert.equal((await call(gm,'GET','/api/health')).status,'ok');release();await legacy;
  // scripts/test.sh runs with two AI workers and only one socket loop.
  holdAll=true;releases.length=0;
  const blocked=[imported,second].map(m=>call(gm,'POST',root+'/script-knowledge/rebuild',{module_id:m.id}));
  await until(()=>releases.length===2);
  const start=Date.now();
  const saved=await call(gm,'PUT',root+'/characters/'+character.id,{name:'Saved during model stall'});
  assert.equal(saved.name,'Saved during model stall');
  assert.equal((await call(gm,'GET','/api/health')).status,'ok');
  const queuedJob=await call(gm,'POST',root+'/script-knowledge/rebuild',{module_id:third.id,async:true});
  assert.ok(queuedJob.id);assert.ok(Date.now()-start<2000,'normal writes and durable job submission bypass occupied AI workers');
  holdAll=false;for(const r of releases)r();await Promise.all(blocked);
  await until(async()=>{const j=(await call(gm,'GET',root+'/script-knowledge/builds')).find(j=>j.id===queuedJob.id);assert.notEqual(j.status,'failed',j.error);return j.status==='completed';});

 }
});
