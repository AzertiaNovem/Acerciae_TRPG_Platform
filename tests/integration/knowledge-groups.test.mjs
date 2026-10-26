import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base=process.env.API_BASE||'http://127.0.0.1:18081';
async function request(token,method,path,body,status=200){
  const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data;
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<50;i++){const r=await fn();if(r)return r;await wait(100);}throw Error('condition timeout');}
function socket(token,ch,stream){return new Promise((resolve,reject)=>{
  const ws=new WebSocket(base.replace(/^http/,'ws')+`/ws/${stream}?token=${token}`),messages=[];
  const timer=setTimeout(()=>{ws.close();reject(Error('socket timeout'));},5000);
  ws.on('error',reject);ws.on('message',raw=>{const m=JSON.parse(raw);messages.push(m);if(m.type==='hello')ws.send(JSON.stringify({type:'subscribe',channel_id:ch}));if(m.type==='subscribed'){clearTimeout(timer);resolve({ws,messages});}});
});}
test('Player group privacy and chat references survive HTTP, WebSocket and regrouping',async()=>{
  const suffix=Date.now().toString(36);
  const users=await Promise.all(['keeper','first','second','third'].map(name=>request(null,'POST','/api/auth/register',{username:`kg_${name}_${suffix}`,display_name:name,password:'password'})));
  const [gm,one,two,three]=users;
  const server=await request(gm.token,'POST','/api/servers',{name:'Independent memory '+suffix});
  const ch=(await request(gm.token,'POST',`/api/servers/${server.id}/channels`,{name:'Player group boundaries',knowledge_mode:'isolated',ai_enabled:false})).id;
  const root=`/api/channels/${ch}`;
  for(const user of [one,two,three]){await request(gm.token,'POST',root+'/members',{user_id:user.user.id,role:'player'});await request(user.token,'POST',root+'/characters',{name:user.user.display_name});}
  const main=(await request(gm.token,'GET',root+'/windows'))[0].id;
  const privateWin=(await request(gm.token,'POST',root+'/windows',{name:'First player private',kind:'private',members:[{user_id:one.user.id}]})).id;
  const scene=(await request(gm.token,'POST',root+'/scenes',{title:'KP_SCENE_HIDDEN_http',summary:'KP_SCENE_HIDDEN_http',location:'KP_SCENE_HIDDEN_http'})).id;
  await request(gm.token,'POST',root+`/windows/${main}/scene`,{scene_id:scene});
  await request(gm.token,'POST',root+`/windows/${privateWin}/scene`,{scene_id:scene});
  const post=(token,win,content,extra={})=>request(token,'POST',root+`/windows/${win}/messages`,{content,kind:'narration',...extra});
  const publicMsg=await post(gm.token,main,'You find an old letter on the desk.');
  const secret=await post(gm.token,main,'You find KP_ONLY_TOKEN_http in the locked box.',{visibility:'gm_only'});
  const privateMsg=await post(gm.token,privateWin,'You find GROUP_ONE_TOKEN_http on a violet key.');
  await request(one.token,'GET',root+`/messages/${secret.id}`,undefined,404);
  await request(two.token,'GET',root+`/messages/${privateMsg.id}`,undefined,404);
  const groups=await request(gm.token,'GET',root+'/player-groups');assert.equal(groups.length,3);
  const groupOf=user=>groups.find(g=>g.members.some(m=>m.user_id===user.user.id)).id;
  await request(one.token,'POST',root+'/player-groups',{name:'unauthorized'},403);
  await request(one.token,'PUT',root+`/player-groups/${groupOf(one)}/members/${two.user.id}`,{},403);
  await request(gm.token,'PUT',root+`/player-groups/${groupOf(one)}/members/${gm.user.id}`,{},400);
  const [oneCtx,twoCtx,threeCtx,twoChat]=await Promise.all([socket(one.token,ch,'context'),socket(two.token,ch,'context'),socket(three.token,ch,'context'),socket(two.token,ch,'chat')]);
  try{
    await request(gm.token,'POST',root+'/ai/observe-now',{});
    const gmDocs=await request(gm.token,'GET',root+'/documents'),oneDocs=await request(one.token,'GET',root+'/documents');
    assert.equal(gmDocs.length,6);assert.equal(oneDocs.length,5);assert.ok(oneDocs.every(d=>!gmDocs.some(g=>g.id===d.id)));
    const gmClue=gmDocs.find(d=>d.doc_type==='clue_journal'),oneClue=oneDocs.find(d=>d.doc_type==='clue_journal');
    await request(one.token,'GET',root+`/documents/${gmClue.id}`,undefined,404);
    await request(one.token,'GET',root+`/documents/${gmClue.id}/revisions`,undefined,404);
    await request(two.token,'GET',root+`/documents/${oneClue.id}/revisions`,undefined,404);
    const oneFacts=await request(one.token,'GET',root+'/facts'),threeFacts=await request(three.token,'GET',root+'/facts');
    assert.match(JSON.stringify(oneFacts),/GROUP_ONE_TOKEN/);assert.doesNotMatch(JSON.stringify(oneFacts),/KP_ONLY_TOKEN|KP_SCENE_HIDDEN/);assert.doesNotMatch(JSON.stringify(threeFacts),/GROUP_ONE_TOKEN|KP_ONLY_TOKEN|KP_SCENE_HIDDEN/);
    const beforeCorrection=JSON.stringify(oneFacts);
    const gmDoc=await request(gm.token,'GET',root+`/documents/${gmClue.id}`);
    const entry=gmDoc.entries.find(e=>e.summary.includes('old letter'));
    await request(gm.token,'PUT',root+`/documents/${gmClue.id}/entries/${entry.id}`,{summary:'KP_EDIT_ONLY_http',reason:'private correction'});
    assert.equal(JSON.stringify(await request(one.token,'GET',root+'/facts')),beforeCorrection);
    const quote=await post(one.token,main,'I refer to the earlier letter.',{reference_ids:[publicMsg.id]});assert.deepEqual(quote.reference_ids,[publicMsg.id]);
    await request(one.token,'POST',root+`/windows/${main}/messages`,{content:'bad quote',reference_ids:[secret.id]},404);
    await request(two.token,'POST',root+`/windows/${main}/messages`,{content:'bad quote',reference_ids:[privateMsg.id]},404);
    await request(one.token,'POST',root+`/windows/${main}/messages`,{content:'bad quote',reference_ids:[17]},400);
    await request(one.token,'POST',root+`/windows/${main}/messages`,{content:'too many',reference_ids:Array(6).fill(publicMsg.id)},400);
    await until(()=>oneCtx.messages.some(m=>m.type==='document.updated'));
    assert.ok(!twoCtx.messages.some(m=>m.type==='document.updated' && m.document_id===oneClue.id));
    assert.doesNotMatch(JSON.stringify(oneCtx.messages),/KP_ONLY_TOKEN|KP_EDIT_ONLY|KP_SCENE_HIDDEN/);
    await request(gm.token,'PUT',root+`/player-groups/${groupOf(one)}/members/${two.user.id}`,{});
    await request(two.token,'GET',root+`/documents/${oneClue.id}`,undefined,404); // old generation removed
    assert.equal((await request(two.token,'GET',root+`/messages/${privateMsg.id}`)).id,privateMsg.id);
    await request(two.token,'POST',root+`/windows/${privateWin}/messages`,{content:'cannot speak here'},403);
    const newPrivate=await post(gm.token,privateWin,'You find a green key called SHARED_GROUP_TOKEN_http.');
    await until(()=>twoChat.messages.some(m=>m.type==='message.posted' && m.message.id===newPrivate.id));
    await request(gm.token,'POST',root+'/ai/observe-now',{});
    assert.match(JSON.stringify(await request(two.token,'GET',root+'/facts')),/GROUP_ONE_TOKEN|SHARED_GROUP_TOKEN/);
    assert.doesNotMatch(JSON.stringify(await request(three.token,'GET',root+'/facts')),/GROUP_ONE_TOKEN|SHARED_GROUP_TOKEN/);
    const reference=await post(two.token,main,'See the message I witnessed through our group.',{reference_ids:[privateMsg.id]});assert.deepEqual(reference.reference_ids,[privateMsg.id]);
    // Links carry no copied secret excerpt. A different group can read the new message, but cannot open its source.
    assert.doesNotMatch(JSON.stringify(await request(three.token,'GET',root+`/messages/${reference.id}`)),/GROUP_ONE_TOKEN/);
    await request(three.token,'GET',root+`/messages/${privateMsg.id}`,undefined,404);
    await request(gm.token,'PUT',root+`/player-groups/${groupOf(two)}/members/${two.user.id}`,{});
    await request(two.token,'GET',root+`/messages/${privateMsg.id}`,undefined,404);
    await request(gm.token,'POST',root+'/ai/observe-now',{});
    assert.doesNotMatch(JSON.stringify(await request(two.token,'GET',root+'/facts')),/GROUP_ONE_TOKEN|SHARED_GROUP_TOKEN/);
    assert.ok((await request(gm.token,'GET',root+`/documents/${gmClue.id}`)).entries.some(e=>e.summary==='KP_EDIT_ONLY_http'));
    assert.ok(!threeCtx.messages.some(m=>m.type==='document.updated' && gmDocs.some(d=>d.id===m.document_id)));
  }finally{for(const client of [oneCtx,twoCtx,threeCtx,twoChat])client.ws.close();}
});
