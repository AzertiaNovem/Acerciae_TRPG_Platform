import test from 'node:test';
import assert from 'node:assert/strict';
import { newSession, join, acceptAnswer, approve, allApproved, publicDossier } from '../src/forge/state.mjs';
import { questionCard, controlsCard, command } from '../src/forge/cards.mjs';
import { budgeted, forgeMode, Forge } from '../src/forge/runtime.mjs';
import { applyCandidate } from '../src/forge/apply.mjs';
import { buildConfig } from '../src/config.mjs';
import { Roster } from '../src/roles/roster.mjs';
import { plannerWindowWanted } from '../src/table/social.mjs';
import { Store } from '../src/store.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startForge } from '../src/forge/runtime.mjs';
import { loadState, saveState } from '../src/state.mjs';
const setup = () => {const s=newSession({world:'public',secrets:'SECRET',rule:'pbta'});join(s,{user_id:'a',display_name:'A'});join(s,{user_id:'b',display_name:'B'});s.candidate={world:'world',characters:[]};s.phase='review';return s;};
test('Forge requires improv, preserves completed authority, and planner window is improv-only',()=>{
  const cfg=buildConfig({}, {}, {forge:{enabled:true}});
  assert.throws(()=>forgeMode({...cfg,improv:false},null),/即兴/);
  assert.equal(forgeMode({...cfg,improv:true},null),true);
  assert.equal(forgeMode(cfg,{forge:{phase:'playing'}}),false);
  assert.equal(plannerWindowWanted({improv:{on:false},cfg,plannerMode:()=> 'pace'}),false);
  assert.equal(plannerWindowWanted({improv:{on:true},cfg,plannerMode:()=> 'full'}),true);
});
test('all participants approve exact revision and content; revision clears consent',()=>{
  const s=setup();approve(s,'a',s.revision);assert.equal(allApproved(s),false);
  assert.throws(()=>approve(s,'x',s.revision));assert.throws(()=>approve(s,'b',s.revision-1));
  approve(s,'b',s.revision);assert.equal(allApproved(s),true);
  s.candidate.world='changed';assert.equal(allApproved(s),false);
  acceptAnswer(s,'a','change my concept');assert.equal(s.phase,'interview');assert.deepEqual(s.approvals,{});
  assert.equal(s.facts.at(-1).status,'accepted');assert.equal(JSON.stringify(publicDossier(s)).includes('SECRET'),false);
});
test('interview accepts several answers from one question batch without expiring other participants',()=>{
  const s=newSession({rule:'coc7e'});join(s,{user_id:'a'});join(s,{user_id:'b'});const v=s.revision;
  acceptAnswer(s,'a','first');acceptAnswer(s,'b','second');assert.equal(s.revision,v);assert.equal(s.history.length,2);
});
test('rich cards use only native controls with bounded expanded text',()=>{
  const s=setup(),q={id:'Q1',text:'A question',options:['甲'.repeat(120),'乙'.repeat(120),'丙'.repeat(120)]};
  const doc=questionCard(s,q).hypertext;
  assert.equal(doc.script,undefined);assert.equal(doc.state.custom.max,250);
  assert.ok([...doc.body.at(-1).act.say.replace('{{pick}}',q.options[0]).replace('{{custom}}','😀'.repeat(250))].length<=500);
  assert.ok(controlsCard({...s,phase:'applying'}).hypertext.body.some(n=>n.act.say.includes('继续启用')));
});
test('budget is checked before every attempt, including subsequent repair calls',async()=>{
  let calls=0,used=0;const store={usageSince:()=>({input:used,output:0,cacheRead:0,cacheWrite:0})};
  const llm=budgeted({complete:async()=>{calls++;used+=10;return 'ok';}},store,{dailyTokenBudget:10});
  assert.equal(await llm.complete({purpose:'forge_compile'}),'ok');await assert.rejects(llm.complete({purpose:'forge_review'}),/预算/);assert.equal(calls,1);
});
test('handed-off PC is removed from roster, legacy marked NPC stays',()=>{
  const roster=new Roster({coplayers:[{characterId:'c',seats:[]},{characterId:'legacy',seats:[]}]});
  roster.reconcile([{id:'c',kind:'pc',user_id:'player'},{id:'legacy',kind:'npc',speaking_style:'[co-player]'}],[],{castBy:'gm'});
  assert.equal(roster.isCoplayer('c'),false);assert.equal(roster.isCoplayer('legacy'),true);
});
test('application resumes lost create response using same receipt and hands over only after cards',async()=>{
  const s=setup();s.rule='coc7e';s.candidate={world:'world',characters:[{key:'C1',kind:'player',owner_user_id:'a',name:'Alice',persona:'bio',speaking_style:'style',appearance_prompt:'appearance',role_card:{basic:{player:'A'}}}]};
  for(const u of ['a','b']) approve(s,u,s.revision);
  let creates=0,lost=true;const receipts=new Map(),order=[];
  const api={channel:async()=>({forge_eligible:true}),createCharacter:async(_,b)=>{if(!receipts.has(b.request_id)){creates++;receipts.set(b.request_id,{id:'id',updated_at:'v'});}if(lost){lost=false;throw Error('lost');}return receipts.get(b.request_id);},putCard:async()=>{order.push('card');return {character:{id:'id'}};},putAppearance:async()=>{order.push('appearance');return {};},transferCharacter:async()=>{order.push('owner');return {};}};
  const args={api,channel:{id:'ch'},session:s,save:()=>{},gmId:'gm'};
  await assert.rejects(applyCandidate(args),/lost/);assert.equal(s.phase,'applying');
  await applyCandidate(args);assert.equal(creates,1);assert.deepEqual(order,['card','appearance','owner']);assert.equal(s.phase,'ready');assert.deepEqual(s.characterIds,{C1:'id'});
});
test('runtime only reads submitted messages, ignores old revisions and persists a cardless participant',async()=>{
  const store=new Store(':memory:');let seq=0;const lines=[];
  const api={user:{id:'gm'},channelMembers:async()=>[{user_id:'a',role:'player',display_name:'A'}],windowMembers:async()=>[{user_id:'a'}],createWindow:async()=>({id:'forge'}),windows:async()=>[{id:'forge',purpose:'forge'}],characters:async()=>[],postMessage:async(_,w,b)=>{lines.push(b);return {id:`m${++seq}`};},postHypertext:async()=>({id:`c${++seq}`}),closeHypertext:async()=>{}};
  const f=new Forge({api,cfg:{language:'en'},channel:{id:'ch',forge_eligible:true,rule_system:'coc7e'},store,llm:{complete:()=>{throw Error('unexpected');}}});
  try{await f.init();const m=content=>({seq:++seq,author_id:'a',kind:'ooc',visibility:'window',chat_window_id:'forge',content});
    const old=command(f.s,'join'),cardId=f.s.cards.at(-1);
    const friendly=Object.entries(f.s.bindings[cardId].actions).find(([,action])=>action==='join')[0];
    await f.message({...m(friendly),via_hypertext_id:cardId});assert.ok(f.s.participants.a);
    await f.message(m(old));assert.equal(Object.keys(f.s.participants).length,1);assert.ok(lines.some(b=>b.content.includes('旧版')));
    const q={id:'Q1',text:'Where to begin?',options:['Bookshop','Ship']};f.s.questions=[q];await f.card(questionCard(f.s,q));
    await f.message({...m('开局共创 · Q1：Bookshop / I want a bookshop'),via_hypertext_id:f.s.cards.at(-1)});assert.match(f.s.history.at(-1).text,/Where to begin.*\n.*I want a bookshop/);
    assert.equal(store.get('forge.session').history.length,1);
  }finally{store.close();}
});

test('empty Forge waits; all arrivals can use one invitation, including after a failed delivery and restart',async t=>{
  const store=new Store(':memory:'); t.after(()=>store.close());
  const players=[], seats=new Set(), deliveries=[], greetings=[]; let failCard=true;
  const api={user:{id:'bot'},channelMembers:async()=>[{id:'bot',role:'gm'},...players.map(id=>({id,role:'player'}))],
    createWindow:async(_,doc)=>{for(const p of doc.members) seats.add(p.user_id);return {id:'w'};},windows:async()=>[{id:'w'}],characters:async()=>[],messages:async()=>[],
    windowMembers:async()=>[...seats].map(user_id=>({user_id})),addWindowMember:async(_,w,p)=>seats.add(p.user_id),
    postMessage:async(_,w,b)=>greetings.push(b.content),postHypertext:async(_,w,b)=>{if(failCard) throw Error('offline');deliveries.push({seats:[...seats],doc:b});return {id:'c'+deliveries.length};}};
  const runtime=()=>new Forge({api,cfg:{},channel:{id:'ch',rule_system:'coc7e',forge_eligible:true},store});
  let f=runtime();await f.init();await f.catchup();assert.equal(greetings.length+deliveries.length,0);
  players.push('a','b');await assert.rejects(f.catchup(),/offline/);failCard=false;await f.catchup();
  assert.equal(greetings.length,1);assert.deepEqual(deliveries.map(d=>d.seats),[['a','b']]);
  f=runtime();await f.init();await f.catchup();assert.equal(deliveries.length,1);
  const button=deliveries[0].doc.hypertext.body.find(n=>n.label==='加入共创');
  assert.deepEqual(button.enable_if,{key:'joined',eq:false});assert.deepEqual(button.act.set,{joined:true});
  const click=(seq,author_id)=>f.message({seq,author_id,kind:'ooc',visibility:'window',chat_window_id:'w',via_hypertext_id:'c1',content:button.act.say});
  await click(1,'a'); const afterFirst=deliveries.length;await click(2,'a'); assert.equal(deliveries.length,afterFirst);
  await click(3,'b');assert.deepEqual(Object.keys(f.s.participants),['a','b']);assert.ok(!deliveries.at(-1).doc.hypertext.body.some(n=>n.label==='加入共创'));
  players.push('late');const before=deliveries.length;await f.catchup();await f.catchup();assert.equal(deliveries.length,before+1);
  assert.deepEqual(deliveries.at(-1).seats,['a','b','late']);assert.ok(deliveries.at(-1).doc.hypertext.body.some(n=>n.label==='加入共创'));
});

test('private initial state maps C keys to real IDs exactly once and cannot assign NPC feelings to a co-player',async()=>{
  const {importSeed,createSeed}=await import('../src/forge/seed.mjs');
  const s=setup();s.characterIds={C1:'npc-id',C2:'pc-id'};
  s.worldStateSeed={definitions:[{id:'trust',label:'Trust',description:'NPC trust toward one person',scope:'relation',type:'number',initial:0,min:0,max:100,changeRule:'Changes after kept promises',thresholds:[]}],values:[{metric:'trust',subject:'C1',target:'C2',value:20}]};
  const characters=[{id:'npc-id',kind:'npc'},{id:'pc-id',kind:'pc'}];const first=importSeed({},s,characters);assert.deepEqual(importSeed(first,s,characters),first);
  assert.ok(Object.values(first.worldState.values).some(x=>x.subject==='npc-id'&&x.target==='pc-id'&&x.value===20));
  const wrong={...s,candidate:{world:'World',characters:[{key:'C1',kind:'coplayer'},{key:'C2',kind:'player'}]}};
  await assert.rejects(createSeed({complete:async()=>JSON.stringify(s.worldStateSeed)},wrong),/NPC/);
  assert.equal(JSON.stringify(publicDossier(s)).includes('worldStateSeed'),false);
});

test('Forge hands the selected casual mode to play without losing existing phone state', async () => {
  for (const casual of [true, false, undefined]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-casual-'));
    let runtime, started;
    const channel = { id: 'ch', server_id: 'server', forge_eligible: true, rule_system: 'coc7e' };
    const api = { user: { id: 'gm' }, token: 'fixture', channel: async () => channel, channelMembers: async () => [], characters: async () => [],
      createWindow: async () => ({ id: 'forge' }), windows: async () => [{ id: 'forge', purpose: 'forge' }], postMessage: async () => ({ id: 'message' }), postHypertext: async () => ({ id: 'card' }) };
    try {
      saveState(dir, { channelId: 'ch', casual: { on: true, phones: { player: 'phone-window' } } });
      const cfg = { ...buildConfig({}, {}, { data: { llm: { provider: 'mock' } } }), stateDir: dir, apiBase: 'http://127.0.0.1:0', improv: true, casual };
      runtime = await startForge({ cfg, api, channel, release: () => {}, managed: true, log: () => {}, run: async () => { started = loadState(dir, 'ch'); return { stop: async () => {} }; } });
      Object.assign(runtime.table.s, { candidate: { world: 'Confirmed world', opening: 'The door opens', characters: [] }, privateWorld: 'Secret', characterIds: {} });
      await runtime.table.onStart(runtime.table.s);
      assert.equal(started.casual.on, casual ?? true);
      assert.deepEqual(started.casual.phones, { player: 'phone-window' });
      assert.equal(started.forge.phase, 'playing'); assert.equal(started.improv.on, true);
    } finally { await runtime?.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
