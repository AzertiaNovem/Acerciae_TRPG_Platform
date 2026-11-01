// The living world record: Keeper declarations, entity state from play, partitions, review of the Keeper's state.
// Run against a server with the mock LLM (no LLM key): API_BASE=http://localhost:18080 node --test world.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base=process.env.API_BASE||'http://127.0.0.1:18081';
async function request(token,method,path,body,status=200){
  const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();assert.equal(res.status,status,`${method} ${path}: ${JSON.stringify(data)}`);return data;
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label='condition'){for(let i=0;i<100;i++){const r=await fn();if(r)return r;await wait(100);}throw Error('timeout: '+label);}
function socket(token,ch,stream){return new Promise((resolve,reject)=>{
  const ws=new WebSocket(base.replace(/^http/,'ws')+`/ws/${stream}?token=${token}`),messages=[];
  const timer=setTimeout(()=>{ws.close();reject(Error('socket timeout'));},5000);
  ws.on('error',reject);ws.on('message',raw=>{const m=JSON.parse(raw);messages.push(m);if(m.type==='hello')ws.send(JSON.stringify({type:'subscribe',channel_id:ch}));if(m.type==='subscribed'){clearTimeout(timer);resolve({ws,messages});}});
});}
const byName=(world,name)=>world.entities.find(e=>e.name===name);

test('Keeper declarations and play keep a living world record per memory partition',async()=>{
  const suffix=Date.now().toString(36);
  const [gm,player]=await Promise.all(['keeper','player'].map(name=>request(null,'POST','/api/auth/register',{username:`world_${name}_${suffix}`,display_name:name,password:'password'})));
  const server=await request(gm.token,'POST','/api/servers',{name:'World record '+suffix});
  const ch=(await request(gm.token,'POST',`/api/servers/${server.id}/channels`,{name:'World',knowledge_mode:'isolated'})).id;
  const root=`/api/channels/${ch}`;
  await request(gm.token,'POST',root+'/members',{user_id:player.user.id,role:'player'});
  await request(player.token,'POST',root+'/characters',{name:'Iris Vale'});
  const main=(await request(gm.token,'GET',root+'/windows'))[0].id;
  const post=(token,content,kind='narration')=>request(token,'POST',root+`/windows/${main}/messages`,{content,kind});
  const [gmCtx,playerCtx]=await Promise.all([socket(gm.token,ch,'context'),socket(player.token,ch,'context')]);
  try{
    // Play: a witnessed death reaches both the Keeper's record and the player's group.
    await post(gm.token,'Constable Barnes is dead.');
    await request(gm.token,'POST',root+'/ai/observe-now',{});
    let kp=await request(gm.token,'GET',root+'/world');
    assert.equal(byName(kp,'Constable Barnes').status,'dead');assert.equal(byName(kp,'Constable Barnes').state_by,'ai');
    let mine=await request(player.token,'GET',root+'/world');
    assert.equal(byName(mine,'Constable Barnes').status,'dead');
    assert.notEqual(byName(mine,'Constable Barnes').id,byName(kp,'Constable Barnes').id);
    await until(()=>gmCtx.messages.some(m=>m.type==='world.updated'&&m.version===kp.version),'Keeper world.updated');
    await until(()=>playerCtx.messages.some(m=>m.type==='world.updated'&&m.version===mine.version),'group world.updated');

    // Validation and authority.
    await request(player.token,'POST',root+'/world/declare',{text:'The Old Mill burns.'},403);
    await request(gm.token,'POST',root+'/world/declare',{text:'   '},400);
    await request(gm.token,'POST',root+'/world/declare',{text:'x'.repeat(4001)},400);

    // An off-screen secret: authoritative for the Keeper, invisible to the players.
    const playerSeen=playerCtx.messages.length;
    const secret=await request(gm.token,'POST',root+'/world/declare?observe=true',{text:'Off-screen, the Old Mill burns to the ground.',secret:true});
    assert.ok(secret.event_id&&secret.seq>0);assert.ok(Array.isArray(secret.jobs));
    kp=await request(gm.token,'GET',root+'/world');
    const mill=byName(kp,'Old Mill');
    assert.equal(mill.status,'destroyed');assert.equal(mill.state_by,'gm');
    assert.ok(kp.recent_changes.some(c=>c.name==='Old Mill'&&c.actor==='gm'));
    await until(()=>gmCtx.messages.some(m=>m.type==='world.updated'&&m.version===kp.version),'Keeper world.updated after the declaration');
    const declared=await request(gm.token,'GET',root+`/events/${secret.event_id}`);
    assert.equal(declared.kind,'gm.declared');assert.equal(declared.payload.secret,true);
    const kpFacts=await request(gm.token,'GET',root+'/facts?q=Mill');
    assert.ok(kpFacts.some(f=>f.status==='gm_secret'),JSON.stringify(kpFacts));

    // A public declaration, observed by the explicit run.
    const missing=await request(gm.token,'POST',root+'/world/declare',{text:'Doctor Mora is missing.'});
    await request(gm.token,'POST',root+'/ai/observe-now',{});
    kp=await request(gm.token,'GET',root+'/world');
    assert.equal(byName(kp,'Doctor Mora').status,'missing');assert.equal(byName(kp,'Doctor Mora').state_by,'gm');
    assert.ok((await request(gm.token,'GET',root+'/facts?q=Mora')).some(f=>f.status==='confirmed'));

    // Players never see a declaration, its effects or a notification about it.
    mine=await request(player.token,'GET',root+'/world');
    assert.doesNotMatch(JSON.stringify(mine),/Old Mill|Mora/);
    await request(player.token,'GET',root+`/events/${secret.event_id}`,undefined,404);
    assert.deepEqual(await request(player.token,'GET',root+`/events?ids=${secret.event_id},${missing.event_id}`),[]);
    assert.deepEqual(await request(player.token,'GET',root+'/events?q=Mill'),[]);
    assert.doesNotMatch(JSON.stringify(await request(player.token,'GET',root+`/windows/${main}/messages`)),/Old Mill|Mora/);
    assert.doesNotMatch(JSON.stringify(await request(player.token,'GET',root+'/facts')),/Old Mill|Mora/);
    assert.doesNotMatch(JSON.stringify(playerCtx.messages.slice(playerSeen)),/Old Mill|Mora|world\.updated/);

    // Play contradicting the Keeper's state goes to review; accepting it makes it the Keeper's.
    await post(player.token,'Doctor Mora is dead, I found her in the cellar.','ic');
    await request(gm.token,'POST',root+'/ai/observe-now',{});
    kp=await request(gm.token,'GET',root+'/world');
    assert.equal(byName(kp,'Doctor Mora').status,'missing');
    const pending=(await request(gm.token,'GET',root+'/proposals?status=needs_gm_review')).find(p=>p.ops[0].op==='entity_state'&&p.ops[0].entity_name==='Doctor Mora');
    assert.ok(pending,'world review proposal');
    await request(player.token,'GET',root+'/proposals',undefined,403);
    assert.equal((await request(gm.token,'POST',root+`/proposals/${pending.id}/decide`,{accept:true})).status,'committed');
    kp=await request(gm.token,'GET',root+'/world');
    assert.equal(byName(kp,'Doctor Mora').status,'dead');assert.equal(byName(kp,'Doctor Mora').state_by,'gm');
    // The group learned of it from its own chat only.
    mine=await request(player.token,'GET',root+'/world');
    assert.equal(byName(mine,'Doctor Mora').status,'dead');assert.doesNotMatch(JSON.stringify(mine),/Old Mill|missing/);
  }finally{gmCtx.ws.close();playerCtx.ws.close();}
});
