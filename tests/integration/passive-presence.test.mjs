import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function request(token, method, path, body, status = 200) {
  const r = await fetch(base + path, { method, headers: {'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})}, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json(); assert.equal(r.status,status,`${method} ${path}: ${JSON.stringify(data)}`); return data;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function eventually(fn) { for (let i=0;i<100;i++) { const result=fn(); if(result) return result; await sleep(50); } throw Error('event did not arrive'); }
function connect(token,ch) {
  return new Promise((resolve,reject) => {
    const ws = new WebSocket(base.replace(/^http/,'ws') + `/ws/chat?token=${token}`), events=[];
    const timer=setTimeout(()=>{ws.close();reject(Error('socket timeout'));},8000);
    ws.on('error',reject); ws.on('message',raw=>{ const e=JSON.parse(String(raw)); events.push(e); if(e.type==='hello') ws.send(JSON.stringify({type:'subscribe',channel_id:ch})); if(e.type==='subscribed') {clearTimeout(timer);resolve({ws,events});} });
  });
}
test('passive presence: GM-only marking, visible stand-ins, owner unlimited recall', { timeout: 180000 }, async () => {
  const suffix=Date.now().toString(36), users={};
  for (const role of ['gm','alice','bob']) users[role]=await request(null,'POST','/api/auth/register',{username:`daily_${role}_${suffix}`,display_name:role,password:'password'});
  const gm=users.gm.token, alice=users.alice.token, bob=users.bob.token;
  const server=await request(gm,'POST','/api/servers',{name:'Daily presence'});
  const ch=(await request(gm,'POST',`/api/servers/${server.id}/channels`,{name:'School',knowledge_mode:'public'})).id, root=`/api/channels/${ch}`;
  for (const who of ['alice','bob']) await request(gm,'POST',root+'/members',{user_id:users[who].user.id,role:'player'});
  const pc=await request(alice,'POST',root+'/characters',{name:'Alice'});
  const npc=await request(gm,'POST',root+'/characters',{name:'Teacher',kind:'npc'});
  const cast=await request(gm,'POST',root+'/characters',{name:'Harriet',kind:'pc'});
  const window=(await request(gm,'GET',root+'/windows'))[0].id, say=root+`/windows/${window}/messages`;
  const socket=await connect(alice,ch);
  try {
    const line=await request(gm,'POST',say,{character_id:pc.id,content:'Let me think about it.',stand_in:true});
    const eventsFound=await request(gm,'GET',root+'/events?q=think');
    assert.ok(eventsFound.some(e=>e.kind==='message.posted'&&e.payload.stand_in===true));
    assert.equal(line.stand_in,true); assert.equal(line.author_id,users.gm.user.id);
    assert.equal((await eventually(()=>socket.events.find(e=>e.type==='message.posted'&&e.message.id===line.id))).message.stand_in,true);
    await request(alice,'POST',say,{character_id:pc.id,content:'invalid',stand_in:true},400);
    for (const character_id of [npc.id,cast.id]) await request(gm,'POST',say,{character_id,content:'invalid',stand_in:true},400);
    for (const extra of [{kind:'narration'},{visibility:'gm_only'},{content:'.r 1d6'},{stand_in:'true'}]) await request(gm,'POST',say,{character_id:pc.id,content:'invalid',stand_in:true,...extra},400);
    await request(bob,'POST',root+`/messages/${line.id}/recall`,undefined,403);
    const presence=root+`/characters/${pc.id}/presence`;
    await request(alice,'PUT',presence,{passive:true},403);
    await request(gm,'PUT',root+`/characters/${npc.id}/presence`,{passive:true},400);
    await request(gm,'PUT',presence,{passive:'true'},400);
    const mark=await request(gm,'PUT',presence,{passive:true}); assert.ok(mark.passive_since);
    assert.equal((await request(gm,'PUT',presence,{passive:true})).passive_since,mark.passive_since);
    await eventually(()=>socket.events.find(e=>e.type==='character.updated'&&e.character?.id===pc.id&&e.character.passive_since));
    assert.ok((await request(alice,'GET',root+'/characters')).find(c=>c.id===pc.id).passive_since);
    assert.equal((await request(gm,'PUT',presence,{passive:false})).passive_since,null);
    const project=await request(gm,'POST',root+'/studio/projects',{title:'Daily life'});
    await request(gm,'POST',root+`/studio/projects/${project.id}/sync`,{});
    const events=await request(gm,'GET',root+`/studio/projects/${project.id}/events`);
    const imported=events.find(e=>e.source_message_id===line.id); assert.equal(imported.metadata.stand_in,true); assert.equal(imported.speaker_role,'pc');
    const exported=await request(gm,'GET',root+'/studio/log/export?format=json'); assert.ok(exported.messages.some(m=>m.stand_in===true));
    // Exercise the real 120-second boundary without a privileged mutation or changing the server clock.
    const sent=Date.parse(line.created_at); await sleep(Math.max(0,sent+121000-Date.now()));
    await request(gm,'POST',root+`/messages/${line.id}/recall`,undefined,409);
    const recalled=await request(alice,'POST',root+`/messages/${line.id}/recall`); assert.ok(recalled.message.recalled_at);
    await eventually(()=>socket.events.find(e=>e.type==='message.recalled'&&e.message.id===line.id));
  } finally { socket.ws.close(); }
});
