import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorldState, applyWorldOperation, seedWorldState, stateView, valueKey, pruneWorldState, renderWorldState } from '../src/world-state/state.mjs';
import { WorldDraft, changeInventory } from '../src/world-state/tools.mjs';
import { commitWorldGroup, recoverWorldState, undoWorldCheckpoint, plannerWorldTools, runWorldAction } from '../src/table/world-state.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const characters = [{ id:'npc',name:'Maren',kind:'npc' },{id:'alice',name:'Alice',kind:'pc'},{id:'bob',name:'Bob',kind:'pc'},{id:'cp',name:'Companion',kind:'pc'}];
const ctx = { characters, npcIds:['npc'], scene:'one', now:1700000000000 };
const trust = {id:'trust',label:'信任',description:'NPC 对具体对象的信任',scope:'relation',type:'number',initial:0,min:0,max:10,maxChangePerScene:3,changeRule:'Honesty +1; risking oneself +2.',thresholds:[{id:'journal',event:'Share the journal with this target',when:{all:[{metric:'trust',op:'>=',value:2}]}}]};
const define = (s=emptyWorldState(), definition=trust) => applyWorldOperation(s,{type:'define',definition,reason:'World setup'},ctx);
const set = (s,target,value,expected=0,extra={}) => applyWorldOperation(s,{type:'set',metric:'trust',subject:'npc',target,expected,value,reason:'Kept a promise'}, {...ctx,...extra});

test('directed NPC attitudes and unlocks stay independent for each human and co-player',()=>{
  let s=set(define(),'alice',2); s=set(s,'bob',1); s=set(s,'cp',3);
  assert.equal(s.values[valueKey('trust','npc','alice')].value,2);
  assert.equal(s.values[valueKey('trust','npc','bob')].value,1);
  assert.equal(s.values[valueKey('trust','npc','cp')].value,3);
  assert.deepEqual(s.events.map(e=>e.target),['alice','cp']);
  assert.equal(Object.keys(s.values).length,3);
  assert.throws(()=>applyWorldOperation(s,{type:'set',metric:'trust',subject:'cp',target:'npc',expected:0,value:1,reason:'reciprocal'},ctx),/Only a real NPC/);
  assert.throws(()=>set(s,'unknown',1),/distinct target/);
});
test('bounds, expected values and cumulative scene allowance are enforced without mutating the input',()=>{
  const s=set(define(),'alice',2), before=JSON.stringify(s);
  assert.throws(()=>set(s,'alice',4,2),/allowance/);
  assert.throws(()=>set(s,'alice',11,2),/between/);
  assert.throws(()=>set(s,'alice',1,0),/State changed/);
  assert.equal(JSON.stringify(s),before);
  assert.equal(set(s,'alice',4,2,{scene:'two'}).values[valueKey('trust','npc','alice')].value,4);
});
test('thresholds fire once per pair even after values cross again or definitions are revised',()=>{
  let s=set(define(),'alice',2); s=set(s,'alice',1,2); s=set(s,'alice',2,1,{scene:'two'});
  s=applyWorldOperation(s,{type:'define',definition:{...trust,description:'Reworded'},expectedRevision:1,reason:'clarity'},ctx);
  assert.equal(s.events.length,1);
  assert.throws(()=>applyWorldOperation(s,{type:'define',definition:trust,reason:'stale'},ctx),/revision/);
});
test('typed flags and all/any conditions use values from the same pair',()=>{
  const flag={id:'promise',label:'守约',description:'Known promise',scope:'relation',type:'boolean',initial:false,changeRule:'Set only when kept',thresholds:[]};
  let s=define(emptyWorldState(),flag);
  s=define(s,{...trust,thresholds:[{id:'both',event:'Reveal',when:{all:[{metric:'trust',op:'>=',value:2},{metric:'promise',op:'==',value:true}]}}]});
  s=applyWorldOperation(s,{type:'set',metric:'promise',subject:'npc',target:'bob',expected:false,value:true,reason:'Bob kept it'},ctx);
  s=set(s,'alice',2); assert.equal(s.events.length,0);
  s=applyWorldOperation(s,{type:'set',metric:'promise',subject:'npc',target:'alice',expected:false,value:true,reason:'Alice kept it'},ctx);
  assert.equal(s.events[0].target,'alice');
  assert.throws(()=>applyWorldOperation(s,{type:'set',metric:'promise',subject:'npc',target:'cp',expected:false,value:1,reason:'bad'},ctx),/boolean/);
});
test('Forge maps stable character keys, rejects invalid subjects, and imports a seed once',()=>{
  const seed={definitions:[trust],values:[{metric:'trust',subject:'C1',target:'C2',value:6}]};
  const opts={characters,characterIds:{C1:'npc',C2:'cp'},sourceId:'forge:one:1',now:ctx.now};
  const s=seedWorldState(null,seed,opts);
  assert.equal(s.values[valueKey('trust','npc','cp')].value,6);
  assert.deepEqual(seedWorldState(s,seed,opts),s);
  assert.throws(()=>seedWorldState(s,{...seed,values:[]},opts),/changed after activation/);
  assert.throws(()=>seedWorldState(null,seed,{...opts,characterIds:{C1:'cp',C2:'alice'}}),/real NPC/);
});
test('pending opportunities wait for presence; rename preserves identity; history pruning keeps unlock dedup',()=>{
  let s=set(define(),'alice',2); const id=s.events[0].id;
  assert.throws(()=>applyWorldOperation(s,{type:'resolve',eventId:id,status:'done',reason:'Reveal'}, {...ctx,canResolve:()=>false}),/wait/);
  s=applyWorldOperation(s,{type:'resolve',eventId:id,status:'done',reason:'Revealed'},ctx);
  assert.equal(stateView(s,{characters:[{id:'alice',name:'Renamed'}]}).values[0].targetName,'Renamed');
  pruneWorldState(s,ctx.now+31*86400000); assert.equal(s.audit.length,0);assert.equal(s.events.length,0);assert.equal(Object.keys(s.fired).length,1);
  s=set(s,'alice',1,2,{scene:'new'});s=set(s,'alice',2,1,{scene:'next'});assert.equal(s.events.length,0);
});
test('inventory transfer conserves quantities and refuses stale/negative changes',()=>{
  const rows=[{id:'alice',version:1,items:[{name:'Key',note:'brass',qty:2}]},{id:'cp',version:3,items:[]}];
  const result=changeInventory(rows,{kind:'transfer',owner:'alice',recipient:'cp',itemIndex:0,expectedQty:2,quantity:1});
  assert.equal(result[0].items[0].qty,1);assert.equal(result[1].items[0].qty,1);assert.equal(rows[0].items[0].qty,2);
  assert.throws(()=>changeInventory(rows,{kind:'lose',owner:'alice',itemIndex:0,expectedQty:1,quantity:1}),/changed/);
  assert.throws(()=>changeInventory(rows,{kind:'gain',owner:'alice',name:'Key',quantity:-1}),/positive/);
});
test('draft tools stay staged, bind exact prose, reject wrong evidence and planner writes',()=>{
  const initial=define(), d=new WorldDraft(initial,{...ctx,lines:[{seq:10,kind:'ic'}]});
  d.call('world_state_set',{metric:'trust',subject:'npc',target:'cp',expected:0,value:2,reason:'Helped',basis:{kind:'reply',quote:'她递出那本日志。'}},'call1');
  assert.equal(Object.keys(initial.values).length,0);
  assert.throws(()=>d.bind({actions:[{type:'narrate',text:'Something else'}]}),/exactly one/);
  assert.equal(d.bind({actions:[{type:'npc',text:'她递出那本日志。',name:'Maren'}]}).get(0).length,1);
  assert.throws(()=>d.call('world_state_set',{metric:'trust',subject:'npc',target:'alice',expected:0,value:1,reason:'invented',basis:{kind:'observed',seq:11}},'x'),/supplied/);
  const view=renderWorldState(d.state,{characters});assert.match(view,/npc.*cp/);assert.doesNotMatch(view,/undefined/);
});

function runtime() {
  let disk, failSave=false, posts=0, writes=0, losePost=false, loseInventory=false;
  const inventory=[{id:'alice',name:'Alice',version:0,items:[{name:'Key',note:'',qty:1}]},{id:'cp',name:'Companion',version:0,items:[]}];
  const receipts=new Map(), messages=new Map(), cancelled=new Set(), lines=[{seq:1,id:'human',kind:'ic',content:'I give them the key.'}];
  const conflict=()=>Object.assign(Error('version changed'),{status:409});
  const table={worldState:define(),improv:{on:true},worldInventory:structuredClone(inventory),worldInventoryAvailable:true,
    characters:structuredClone(characters),cards:new Map(),botMessageIds:new Set(),turnScope:new AsyncLocalStorage(),cfg:{postDelayMs:0},
    roster:{npcs:[{characterId:'npc'}],npcByName:n=>n==='Maren'?{characterId:'npc'}:null,isCoplayer:id=>id==='cp'},
    calendar:{date:'2026-01-01'},scenario:{id:'s1'},generation:{signal:new AbortController().signal},
    now:()=>ctx.now,nameOf:id=>characters.find(c=>c.id===id)?.name,isPc:id=>['alice','bob'].includes(id),dailyOn:()=>false,isPassive:()=>false,
    scene:()=>({id:'main',members:['alice','cp']}),sceneHistory:()=>lines,primaryWindowId:()=> 'main',noteLine:m=>{if(!lines.some(l=>l.id===m.id))lines.push(m);},
    characterByName:n=>characters.find(c=>c.name===n),persist:t=>{if(failSave)throw Error('disk full');disk=structuredClone(t.worldState);},log:()=>{},sleep:async()=>{},sparkCancelled:()=>false,overBudget:()=>false,
    api:{
      agentMessage:async(_,id)=>({message:messages.get(id)??null,cancelled:cancelled.has(id)}),
      cancelAgentMessage:async(_,id)=>{if(!messages.has(id))cancelled.add(id);return {message:messages.get(id)??null,cancelled:cancelled.has(id)};},
      postMessage:async(_,windowId,body)=>{if(cancelled.has(body.request_id))throw conflict();if(messages.has(body.request_id))return messages.get(body.request_id);posts++;const m={id:`m${posts}`,seq:lines.length+1,chat_window_id:windowId,...body};messages.set(body.request_id,m);if(losePost){losePost=false;throw Error('lost response');}return m;},
      updateInventory:async(_,body)=>{
        if(receipts.has(body.request_id))return receipts.get(body.request_id);
        for(const c of body.changes)if(inventory.find(i=>i.id===c.character_id).version!==c.expected_version)throw conflict();
        writes++;const result={characters:body.changes.map(c=>{const i=inventory.find(i=>i.id===c.character_id);const before_items=structuredClone(i.items);i.items=structuredClone(c.items);i.version++;return {...structuredClone(i),before_items};})};receipts.set(body.request_id,result);
        if(loseInventory){loseInventory=false;throw Error('lost inventory response');}return result;
      },
    }};
  const entries=[{callId:'1',key:'',basis:{kind:'reply',quote:'Maren smiles.'},op:{type:'set',metric:'trust',subject:'npc',target:'cp',expected:0,value:2,reason:'Kindness'}}];
  const transfer={callId:'2',key:'',basis:{kind:'reply',quote:'Maren smiles.'},op:{type:'inventory',kind:'transfer',owner:'alice',recipient:'cp',itemIndex:0,expectedQty:1,quantity:1,reason:'Gift'}};
  return {table,entries,transfer,inventory,lines,action:{type:'narrate',text:'Maren smiles.'},get disk(){return disk;},get posts(){return posts;},get writes(){return writes;},set failSave(v){failSave=v;},set losePost(v){losePost=v;},set loseInventory(v){loseInventory=v;}};
}
test('a validated turn commits its state and inventory exactly once after a lost message response',async()=>{
  const r=runtime();r.losePost=true;
  await assert.rejects(commitWorldGroup(r.table,'main',[...r.entries,r.transfer],r.action),/lost response/);
  assert.equal(r.posts,1);assert.equal(r.writes,1);assert.ok(r.disk.pending);
  r.table.worldState=r.disk; await recoverWorldState(r.table);
  assert.equal(r.posts,1);assert.equal(r.writes,1);assert.equal(r.table.worldState.pending,null);
  assert.equal(r.table.worldState.values[valueKey('trust','npc','cp')].value,2);
});
test('recovery after inventory commit replays its receipt, never transfers twice',async()=>{
  const r=runtime();r.loseInventory=true;
  await assert.rejects(commitWorldGroup(r.table,'main',[...r.entries,r.transfer],r.action),/lost inventory/);
  r.table.worldState=r.disk;await recoverWorldState(r.table);
  assert.equal(r.writes,1);assert.equal(r.posts,1);assert.equal(r.inventory[1].items[0].qty,1);
});
test('pausing an unpublished turn cancels its late message and compensates inventory',async()=>{
  const r=runtime();r.loseInventory=true;
  await assert.rejects(commitWorldGroup(r.table,'main',[...r.entries,r.transfer],r.action));
  r.table.generation.signal=AbortSignal.abort();await recoverWorldState(r.table);
  assert.equal(r.posts,0);assert.equal(r.inventory[0].items[0].qty,1);assert.equal(r.inventory[1].items.length,0);
  assert.equal(Object.keys(r.table.worldState.values).length,0);
});
test('a definite inventory conflict discards the draft and never publishes its claim',async()=>{
  const r=runtime();r.inventory[0].version++;
  await assert.rejects(commitWorldGroup(r.table,'main',[...r.entries,r.transfer],r.action),/version/);
  assert.equal(r.posts,0);assert.equal(r.table.worldState.pending,null);assert.equal(Object.keys(r.table.worldState.values).length,0);
});
test('failure to save the intent makes no remote writes',async()=>{
  const r=runtime();r.failSave=true;
  await assert.rejects(commitWorldGroup(r.table,'main',[...r.entries,r.transfer],r.action),/disk full/);
  assert.equal(r.posts,0);assert.equal(r.writes,0);assert.equal(r.table.worldState.pending,null);
});
test('an expired missing receipt preserves the uncertain intent for reconciliation',async()=>{
  const r=runtime();
  r.table.api.updateInventory=async()=>{throw Object.assign(Error('expired receipt'),{status:409,code:'inventory_request_expired'});};
  await assert.rejects(commitWorldGroup(r.table,'main',[r.transfer],r.action),/expired/);
  assert.ok(r.table.worldState.pending);assert.ok(r.disk.pending);assert.equal(r.posts,0);
});
test('recall restores state and transfers with optimistic concurrency',async()=>{
  const r=runtime(), before=JSON.stringify(r.table.worldState),cp={running:true,posted:[],worldInventory:[],before:{world:before}};
  await r.table.turnScope.run(cp,()=>commitWorldGroup(r.table,'main',[...r.entries,r.transfer],r.action));
  await undoWorldCheckpoint(r.table,cp);assert.equal(r.inventory[0].items[0].qty,1);assert.equal(r.inventory[1].items.length,0);assert.deepEqual(r.table.worldState,JSON.parse(before));
});
test('recall cannot overwrite inventory changed by someone else',async()=>{
  const r=runtime(),cp={running:true,posted:[],worldInventory:[],before:{world:JSON.stringify(r.table.worldState)}};
  await r.table.turnScope.run(cp,()=>commitWorldGroup(r.table,'main',[...r.entries,r.transfer],r.action));
  r.inventory[1].version++;r.inventory[1].items[0].qty=3;
  await assert.rejects(undoWorldCheckpoint(r.table,cp),/version/);assert.equal(r.inventory[1].items[0].qty,3);
});
test('planner state is read-only and frozen for its cycle',()=>{
  const r=runtime(),tools=plannerWorldTools(r.table);
  assert.deepEqual(tools.tools.map(t=>t.name),['world_state_read']);
  assert.throws(()=>tools.call('world_state_set',{}),/read-only/);
  r.table.worldState=set(r.table.worldState,'cp',2);
  assert.equal(tools.call('world_state_read',{}).values.length,0);
});
test('state-linked messages obey spark and unattended line limits without committing edits',async()=>{
  for(const cp of [{mode:'spark',dailyPosted:1,lineLimit:1},{gentle:true,dailyBudget:{posted:1,limit:1}}]) {
    const r=runtime();
    assert.equal(await r.table.turnScope.run(cp,()=>runWorldAction(r.table,'main',r.entries,r.action,()=>{throw Error('must not post');})),0);
    assert.equal(r.posts,0);assert.equal(r.writes,0);assert.equal(Object.keys(r.table.worldState.values).length,0);
  }
});
