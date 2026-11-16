import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../../gm-agent/src/api.mjs';
import { Store } from '../../gm-agent/src/store.mjs';
import { Forge } from '../../gm-agent/src/forge/runtime.mjs';
import { command, questionCard } from '../../gm-agent/src/forge/cards.mjs';
import { newSession, hash } from '../../gm-agent/src/forge/state.mjs';
const base=process.env.API_BASE||'http://localhost:18081';
async function fixture(rule='pbta') {
  const tag=crypto.randomUUID().slice(0,8),gm=new Api(base),a=new Api(base),b=new Api(base),outsider=new Api(base);
  for(const [client,name] of [[gm,'gm'],[a,'alice'],[b,'bob'],[outsider,'outside']]) await client.register(name+tag,'password',name);
  const server=await gm.createServer('Forge tests'),channel=await gm.createChannel(server.id,{name:'Unwritten',rule_system:rule});
  for(const client of [a,b]) await gm.post(`/api/channels/${channel.id}/members`,{user_id:client.user.id,role:'player'});
  const main=(await gm.windows(channel.id)).find(w=>w.kind==='main');return {gm,a,b,outsider,channel:await gm.channel(channel.id),main};
}
test('Forge windows/cards stay out of scenes and cannot be forked into fiction; owners have CAS and isolated bindings',async()=>{
  const {gm,a,b,outsider,channel:ch,main}=await fixture('coc7e');
  const create={name:'Preparation',purpose:'forge',request_id:'prep',members:[{user_id:a.user.id}]};
  const w=await gm.createWindow(ch.id,create);assert.equal((await gm.createWindow(ch.id,create)).id,w.id);
  await assert.rejects(gm.createWindow(ch.id,{...create,name:'Changed'}),{status:409});
  const line=await a.postMessage(ch.id,w.id,{kind:'ic',content:'Only a proposed story'});assert.equal(line.scene_id,null);assert.equal((await gm.channel(ch.id)).forge_eligible,true);
  await assert.rejects(gm.forkWindow(ch.id,w.id,{name:'bad',members:[]}),{status:409});
  const s=newSession({rule:'coc7e'}),card=questionCard(s,{id:'Q1',text:'想要什么故事？',options:['书店里的秘密','迷路的星船']});
  const rich=await gm.postHypertext(ch.id,w.id,card);assert.equal(rich.kind,'hypertext');assert.equal(rich.scene_id,null);
  const c=await gm.createCharacter(ch.id,{name:'Human to be',kind:'pc',request_id:'pc'});
  assert.equal((await gm.createCharacter(ch.id,{name:'Human to be',kind:'pc',request_id:'pc'})).id,c.id);
  const hidden=await gm.createWindow(ch.id,{name:'GM private',kind:'private',members:[]});
  for(const client of [a,outsider]) await assert.rejects(client.transferCharacter(ch.id,c.id,{user_id:a.user.id,expected_user_id:gm.user.id}),{status:403});
  await assert.rejects(gm.transferCharacter(ch.id,c.id,{user_id:outsider.user.id,expected_user_id:gm.user.id}),{status:400});
  await assert.rejects(gm.transferCharacter(ch.id,c.id,{user_id:a.user.id,expected_user_id:b.user.id}),{status:409});
  await gm.transferCharacter(ch.id,c.id,{user_id:a.user.id,expected_user_id:gm.user.id});
  assert.equal((await gm.transferCharacter(ch.id,c.id,{user_id:a.user.id,expected_user_id:gm.user.id})).user_id,a.user.id);
  assert.equal((await a.windows(ch.id)).some(x=>x.id===hidden.id),false);
  const members=await gm.get(`/api/channels/${ch.id}/windows/${main.id}/members`);assert.equal(members.find(m=>m.user_id===a.user.id).character_id,c.id);
  await assert.rejects(gm.postMessage(ch.id,main.id,{kind:'ic',content:'stale AI line',character_id:c.id,expected_owner_id:gm.user.id}),{status:409});
  await a.postMessage(ch.id,main.id,{kind:'ic',content:'The real story begins',character_id:c.id});assert.equal((await gm.channel(ch.id)).forge_eligible,false);
});
test('PbtA pack and sheets activate atomically, retries survive lost responses, and conflicts do not partially write',async()=>{
  const {gm,a,channel:ch}=await fixture();const old=await gm.pbtaRules(ch.id),draft=await gm.pbtaDraft(ch.id),pack=structuredClone(old.pack);
  pack.name='Together';pack.books[0].name='Bookshop keeper';
  const c={key:'C1',kind:'player',owner_user_id:a.user.id,name:'Keeper',persona:'Runs a shop',speaking_style:'Plain',appearance_prompt:'Apron',role_card:{basic:{player:'alice'},pbta:{book:pack.books[0].id,stats:Object.fromEntries(pack.stats.map(x=>[x.id,1])),resources:Object.fromEntries(pack.resources.map(x=>[x.id,2])),conditions:{}}}};
  const bundle=await gm.previewPbta(ch.id,{pack,characters:[c]});
  const submitted=await gm.reviewPbta(ch.id,{...bundle,op:'forge_submit',version:draft.version,revision:old.revision,world_hash:hash('world'),request_id:'submit'});
  const activate={op:'activate',version:submitted.version,revision:old.revision,pack:submitted.pack,characters:submitted.characters,request_id:'activate'};
  await assert.rejects(gm.reviewPbta(ch.id,{...activate,characters:[{...c,owner_user_id:crypto.randomUUID()}]}),{status:409});
  assert.equal((await gm.characters(ch.id)).length,0);assert.equal((await gm.pbtaRules(ch.id)).revision,old.revision);
  const done=await gm.reviewPbta(ch.id,activate),again=await gm.reviewPbta(ch.id,activate);
  assert.deepEqual(done,again);assert.equal(done.applied.characters.length,1);assert.equal((await gm.characters(ch.id)).length,1);
  const id=done.applied.characters[0].character.id;assert.equal((await gm.characterSpace(ch.id,id)).character.role_card.pbta.book,pack.books[0].id);
  assert.equal((await gm.pbtaRules(ch.id)).pack.name,'Together');
  // A late card edit is detected inside activation, after an earlier new card has already been inserted.
  const existing=await a.createCharacter(ch.id,{name:'Existing hero'}),current=await gm.pbtaDraft(ch.id);
  const nextPack={...pack,name:'Must roll back'};
  const joint=await gm.previewPbta(ch.id,{pack:nextPack,characters:[{...c,key:'C3',name:'Temporary hero'},{...c,key:'C4',name:'Existing hero',existing_id:existing.id,expected_updated_at:existing.updated_at}]});
  const pending=await gm.reviewPbta(ch.id,{...joint,op:'forge_submit',version:current.version,revision:current.revision,world_hash:hash('new world'),request_id:'second-submit'});
  await a.putAppearance(ch.id,existing.id,{appearance_prompt:'A newly edited appearance'});
  await assert.rejects(gm.reviewPbta(ch.id,{op:'activate',version:pending.version,revision:pending.revision,pack:pending.pack,characters:pending.characters,request_id:'conflicting-activate'}),{status:409});
  assert.equal((await gm.characters(ch.id)).length,2,'the temporary hero insert rolled back');
  assert.equal((await gm.pbtaRules(ch.id)).pack.name,'Together','the official pack rolled back too');
});
test('complete pre-game Forge: two cardless players, joint generation, shared consent, private truth, handoff and explicit start',async()=>{
  const {gm,a,b,channel}=await fixture();const store=new Store(':memory:'),calls=[];let started=false;
  const template=(await gm.pbtaRules(channel.id)).pack;
  const llm={complete:async req=>{calls.push(req);if(req.retryReason) throw Error(req.retryReason);const user=req.messages[0].content;
    if(req.purpose==='forge_interview') return 'Which characters?\nA bookshop. A ship.\nWhat tone? Warm. Uncanny.';
    if(req.purpose==='forge_format') return JSON.stringify({questions:[{text:'角色的愿望？',options:['经营书店','寻找失踪的姐姐']},{text:'基调？',options:['温暖日常','诡秘悬疑']}]});
    if(req.purpose==='forge_review') return JSON.stringify({ok:true,issues:[],substantive:false});
    if(req.purpose==='forge_seed') return JSON.stringify({definitions:[],values:[]});
    if(req.purpose==='forge_secrets') return 'PRIVATE hidden lighthouse signal';
    if(req.purpose==='forge_compile' && req.system.startsWith('Write')) return 'A quiet seaside bookshop. Two friends own it.';
    if(req.purpose==='forge_compile') {const pack=structuredClone(template);pack.name='Bookshop';for(const move of pack.moves) move.playerChoiceBands=[];pack.books[0].name='Keeper';return JSON.stringify({world:'A seaside bookshop.',opening:'Before opening on Monday.',pack,characters:[a,b].map((p,i)=>({key:'C'+(i+1),kind:'player',owner_user_id:p.user.id,name:i?'Bea':'Ada',persona:'Wants to keep the shop alive.',speaking_style:'Warm',appearance_prompt:'Apron',role_card:{basic:{player:p.user.display_name},background:{},pbta:{book:pack.books[i].id,stats:Object.fromEntries(pack.stats.map(x=>[x.id,1])),resources:Object.fromEntries(pack.resources.map(x=>[x.id,2])),conditions:{}}}}))});}
    throw Error('Unexpected purpose '+req.purpose);
  }};
  const f=new Forge({api:gm,cfg:{language:'en',coplayers:0},channel,store,llm,onStart:async()=>{started=true;}});
  try{await f.init();const act=async(api,action)=>{await api.postMessage(channel.id,f.s.window,{kind:'ooc',content:command(f.s,action)});await f.catchup();};
    await act(a,'join');await act(b,'join');await act(a,'next');assert.equal(f.s.questions.length,2);
    await act(a,'answer Q1 I want the bookshop');await act(b,'answer Q2 Warm and uncanny');await act(a,'compile');assert.equal(f.s.phase,'review');
    await act(a,'approve');await assert.rejects(act(a,'apply'),/确认/);assert.equal((await gm.characters(channel.id)).length,0);
    await act(b,'approve');await act(a,'apply');assert.equal(f.s.phase,'ready');assert.equal(started,false);
    const chars=await gm.characters(channel.id);assert.deepEqual(new Set(chars.map(c=>c.user_id)),new Set([a.user.id,b.user.id]));
    assert.equal((await gm.pbtaRules(channel.id)).pack.name,'Bookshop');
    const messages=await gm.messages(channel.id,f.s.window,100);assert.equal(JSON.stringify(messages).includes('PRIVATE'),false);
    assert.equal(calls.filter(c=>!['forge_secrets','forge_seed'].includes(c.purpose)).some(c=>JSON.stringify(c).includes('PRIVATE')),false);
    assert.equal((await gm.channel(channel.id)).forge_eligible,true);await act(a,'start');assert.equal(started,true);
  }finally{store.close();}
});

test('real runtime resumes preplay, explicitly starts, then ignores the original world file on restart',async()=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
  const {run}=await import('../../gm-agent/src/cli.mjs');const {buildConfig}=await import('../../gm-agent/src/config.mjs');
  const {approve,join}=await import('../../gm-agent/src/forge/state.mjs');const {saveState,loadState}=await import('../../gm-agent/src/state.mjs');
  const {gm,a,channel}=await fixture('coc7e'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-runtime-')),world=path.join(dir,'world.md');
  fs.writeFileSync(world,'ORIGINAL_UNFINISHED_DRAFT');
  const cfg=buildConfig({api:base,username:gm.credentials.username,password:'password',channel:channel.id,'state-dir':dir,improv:true,forge:true,world,coplayers:0,autonomy:false,planner:false,illustrations:false},{});
  let runtime;
  try {
    runtime=await run(cfg,{managed:true});const sessionId=runtime.table.s.id;
    assert.equal(runtime.table.s.phase,'interview');assert.equal((await gm.characters(channel.id)).length,0);
    await runtime.stop();runtime=await run(cfg,{managed:true});assert.equal(runtime.table.s.id,sessionId);
    const s=runtime.table.s;join(s,{user_id:a.user.id,display_name:'A'});s.candidate={world:'FINAL_APPROVED_WORLD',opening:'A slow morning',characters:[]};s.privateWorld='PRIVATE';s.worldStateSeed={definitions:[],values:[]};s.characterIds={};s.phase='review';approve(s,a.user.id,s.revision);s.phase='ready';runtime.table.save();
    await a.postMessage(channel.id,s.window,{kind:'ooc',content:command(s,'start')});
    const prep=runtime.table;await prep.enqueue(()=>prep.catchup());
    assert.equal(loadState(dir,channel.id).forge.phase,'playing');assert.match(runtime.table.improv.world,/FINAL_APPROVED_WORLD/);
    await runtime.stop();runtime=null;
    fs.writeFileSync(world,'MODIFIED_OLD_DRAFT');
    runtime=await run(cfg,{managed:true});assert.match(runtime.table.improv.world,/FINAL_APPROVED_WORLD/);assert.doesNotMatch(runtime.table.improv.world,/DRAFT/);
  } finally {await runtime?.stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test('CoC and D&D generated numbers pass platform preview; card receipts and version guards protect existing sheets',async()=>{
  const {MockLlm}=await import('../../gm-agent/src/llm/mock.mjs');
  const {generateCoplayer}=await import('../../gm-agent/src/roles/cardgen.mjs');
  const {rulesProfile}=await import('../../gm-agent/src/rules/index.mjs');
  for(const rule of ['coc7e','dnd2024']) {
    const {gm,channel:ch}=await fixture(rule);await gm.updateChannel(ch.id,{point_buy:true});
    const profile=rulesProfile(rule),rules=await profile.fetchRules(gm,ch.id);
    const generated=await generateCoplayer(new MockLlm(),{profile,rules,pointsMode:true,language:'English',era:'modern',takenNames:[],partyNotes:'',index:0,total:1,level:1,world:'Bookshop'});
    const card=profile.card.normalize(generated.role_card,{rules,kind:'coplayer',level:1,pointsMode:true});
    const preview=await gm.previewCard(ch.id,{rule_system:rule,role_card:card});
    assert.equal(preview.points.violations.length,0);
    const c=await gm.createCharacter(ch.id,{name:'Reviewed '+rule,kind:'pc'});
    const body={role_card:preview.role_card,rule_system:rule,expected_updated_at:c.updated_at,request_id:'save-reviewed'};
    const first=await gm.putCard(ch.id,c.id,body),again=await gm.putCard(ch.id,c.id,body);
    assert.deepEqual(first.character.role_card,again.character.role_card);
    await assert.rejects(gm.putCard(ch.id,c.id,{...body,request_id:'stale-new-request'}),{status:409});
    assert.equal(first.character.card_pending,false);
  }
});
