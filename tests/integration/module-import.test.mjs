import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
const userText=body=>{const c=body.messages.find(m=>m.role==='user').content;return typeof c==='string'?c:c.filter(b=>b.type==='text').map(b=>b.text).join('');};
const base=process.env.API_BASE||'http://127.0.0.1:18081';
async function call(token,method,path,body) {
 const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const d=await r.json();if(!r.ok)throw Object.assign(Error(JSON.stringify(d)),{status:r.status});return d;
}
async function until(fn) {for(let n=0;n<150;n++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,100));}throw Error('timed out');}
test('module import accepts promptly, reports durable progress, deduplicates retries and rejects truncated model output',async(t)=>{
 let releaseFirst,hold=true,truncated=false,timeoutAbove=0;
 const requests=[];
 const fixture=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;
  const body=JSON.parse(raw);requests.push(body);
  if(hold){hold=false;await new Promise(resolve=>{releaseFirst=resolve;});}
  const module=(body.system||body.messages[0].content).includes('conditional knowledge graph');
  if(module&&timeoutAbove){const ctx=JSON.parse(userText(body));if(ctx.pages.reduce((n,p)=>n+Buffer.byteLength(p.text),0)>timeoutAbove){res.writeHead(504,{'Retry-After':'0'});return res.end('{}');}}
  const content=module?{nodes:[{key:'location|harbour',node_type:'location',name:'Harbour',description:'Rainy stone harbour',citations:[{page:1}]}],edges:[]}:{entries:[]};
  res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/messages'))return res.end(JSON.stringify({content:[{type:'text',text:JSON.stringify(content)}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:30}}));
  res.end(JSON.stringify({choices:[{finish_reason:truncated?'length':'stop',message:{role:'assistant',content:JSON.stringify(content)}}],usage:{prompt_tokens:20,completion_tokens:30}}));
 });
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
 t.after(()=>{releaseFirst?.();fixture.closeAllConnections();fixture.close();});
 const suffix=Math.random().toString(36).slice(2);
 const gm=(await call('', 'POST','/api/auth/register',{username:'modGM'+suffix,password:'password'})).token;
 const pl=(await call('', 'POST','/api/auth/register',{username:'modPL'+suffix,password:'password'})).token;
 const srv=await call(gm,'POST','/api/servers',{name:'Import fixture'});
 const ch=(await call(gm,'POST',`/api/servers/${srv.id}/channels`,{name:'Module testing'})).id;
 await call(gm,'POST',`/api/channels/${ch}/members`,{username:'modPL'+suffix,role:'player'});
 await call(gm,'PUT',`/api/servers/${srv.id}/settings`,{llm:{provider:'openai_compatible',api_base:`http://127.0.0.1:${fixture.address().port}/v1`,api_key:'fixture',model:'fixture'}});
 const root=`/api/channels/${ch}/modules`,text='Scene: Harbour\n'+'雨中的码头。'.repeat(2200);
 const [a,b]=await Promise.all([call(gm,'POST',root+'/text',{title:'Module',text,async:true}),call(gm,'POST',root+'/text',{title:'Same content',text,async:true})]);
 assert.equal(a.id,b.id);assert.notEqual(a.deduplicated,b.deduplicated);
 await until(()=>releaseFirst);
 const progress=await call(gm,'GET',root+'/'+a.id);
 assert.equal(progress.status,'structuring');assert.ok(progress.total_chunks>1);assert.equal(progress.completed_chunks,0);
 assert.equal(requests[0].max_tokens,32768);
 await assert.rejects(call(pl,'GET',root+'/'+a.id),e=>e.status===403);
 await assert.rejects(call(pl,'POST',root+'/'+a.id+'/retry'),e=>e.status===403);
 releaseFirst();
 const ready=await until(async()=>{const m=await call(gm,'GET',root+'/'+a.id);assert.notEqual(m.status,'failed',m.error);return m.status==='ready'&&m;});
 assert.equal(ready.nodes[0].citations[0].excerpt,'','old clients receive a string even for page-only model citations');
 assert.equal(ready.import_stage,'ready');assert.equal(ready.completed_chunks,ready.total_chunks);assert.equal(ready.import_warning,null);
 const moduleCalls=requests.filter(b=>b.messages[0].content.includes('conditional knowledge graph'));
 assert.equal(moduleCalls.length,ready.total_chunks);
 assert.ok(requests.filter(b=>b.messages[0].content.includes("Keeper's working knowledge")).every(b=>b.max_tokens===32768));
 const restored=moduleCalls.flatMap(b=>JSON.parse(b.messages[1].content).pages).map(p=>p.text).join('');
 assert.equal(restored,text);
 assert.equal((await call(gm,'POST',root+'/text',{text,async:true})).id,a.id);
 assert.equal((await call(gm,'GET',root)).length,1);
 truncated=true;
 const fail=await call(gm,'POST',root+'/text',{text:'Scene: Truncated pier',async:true});
 const failed=await until(async()=>{const m=await call(gm,'GET',root+'/'+fail.id);return m.status==='failed'&&m;});
 assert.match(failed.error,/output token limit/);assert.equal(failed.nodes.length,0,'valid-looking partial JSON is never accepted');
 truncated=false;
 const retried=await call(gm,'POST',root+'/'+fail.id+'/retry');assert.equal(retried.id,fail.id);
 await until(async()=>{const m=await call(gm,'GET',root+'/'+fail.id);assert.notEqual(m.status,'failed',m.error);return m.status==='ready';});
 assert.equal((await call(gm,'GET',root)).length,2);
 timeoutAbove=3200;
 for(const provider of ['openai_compatible','anthropic']){
  await call(gm,'PUT',`/api/servers/${srv.id}/settings`,{llm:{provider,api_base:`http://127.0.0.1:${fixture.address().port}/v1`,api_key:'fixture',model:'fixture'}});
  requests.length=0;
  const source=provider+'\n'+'雾中的灯塔。'.repeat(1800);
  const imported=await call(gm,'POST',root+'/text',{text:source,async:true});
  const done=await until(async()=>{const m=await call(gm,'GET',root+'/'+imported.id);assert.notEqual(m.status,'failed',m.error);return m.status==='ready'&&m;});
  const contexts=requests.filter(b=>(b.system||b.messages[0].content).includes('conditional knowledge graph')).map(b=>JSON.parse(userText(b)));
  const accepted=contexts.filter(c=>c.pages.reduce((n,p)=>n+Buffer.byteLength(p.text),0)<=3200);
  assert.equal(contexts.length-accepted.length,6,'two reductions, three HTTP attempts per timed-out chunk');
  assert.equal(accepted.length,done.total_chunks);assert.equal(done.completed_chunks,done.total_chunks);
  assert.equal(accepted.flatMap(c=>c.pages).map(p=>p.text).join(''),source);
 }

});
