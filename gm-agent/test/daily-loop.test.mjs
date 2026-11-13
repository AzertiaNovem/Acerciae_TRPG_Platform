import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table } from '../src/loop.mjs';
import { Roster } from '../src/roles/roster.mjs';
import { MockLlm } from '../src/llm/mock.mjs';
import { buildConfig } from '../src/config.mjs';
import { FakeApi } from './fixtures/platform.mjs';
import { witnessedBy } from '../src/context/standinContext.mjs';
import { timetableAt, DAY } from '../src/daily.mjs';
const H = 3600000, START = 1700000000000;
async function setup({ state, clock = { t: START }, llm = new MockLlm(), daily = {}, api = new FakeApi() } = {}) {
  api.knowledgeMode = 'isolated';
  api.setCharacterPresence = async (_ch,id,passive) => {
    const c = api.characters_.find(c => c.id === id); c.passive_since = passive ? c.passive_since ?? new Date(clock.t).toISOString() : null;
    return structuredClone(c);
  };
  const add = api.add.bind(api); api.add = m => add({ created_at: new Date(clock.t).toISOString(), ...m });
  const cfg = buildConfig({}, {}, { data: {} });
  cfg.daily = { ...cfg.daily, enabled: true, ...daily }; cfg.debounceMs = 0; cfg.postDelayMs = 0;
  cfg.autonomy = false; cfg.planner.enabled = false; cfg.illustrations.enabled = false;
  const t = new Table({ api, cfg, llm, roster: new Roster(), channelId: 'ch', now: () => clock.t, random: () => .5, sleep: async () => {}, improv: { on: true, world: 'School life', secrets: 'HIDDEN-TRUTH' }, casual: { on: true }, calendar: state?.calendar ?? { date: '1923-10-02', time: '10:00', clock: 600, since: {at: START, lines: 0} }, daily: state?.daily, timelines: state?.timelines, log: process.env.TEST_LOG ? console.log : () => {} });
  await t.init(); await t.ensurePhones();
  const human = (content, window = 'w-main', kind = 'ic') => t.onMessage(api.add({ author_id:'u-alice', author_role:'player', character_id:'c-alice', chat_window_id:window, content, kind }));
  return {t,api,clock,llm,human};
}
test('daily runtime: silence, phone independence, restart, pause and resume', async () => {
  const {t,clock,human,api} = await setup();
  clock.t += H; await human('hello', t.casual.phones['c-alice'], 'ooc');
  clock.t += H - 1; await t.clockTick({sparks:false}); assert.equal(t.calendar.clock,600); assert.equal(t.daily.anchor,null);
  clock.t++; await t.clockTick({sparks:false}); assert.equal(t.daily.anchor.realAt,START+2*H);
  clock.t += 17*H; await t.clockTick({sparks:false}); assert.equal(t.calendar.date,'1923-10-03'); assert.equal(t.calendar.clock,600);
  const state = {daily:structuredClone(t.daily), calendar:structuredClone(t.calendar), timelines:t.timelines};
  const restarted = await setup({state,clock,api}); assert.equal(restarted.t.calendar.date,t.calendar.date); assert.equal(restarted.t.calendar.clock,t.calendar.clock);
  clock.t = t.daily.lastHumanAt + 7*DAY + H; await t.clockTick({sparks:false}); const frozen = {...t.daily.frozen};
  clock.t += DAY; await t.clockTick({sparks:false}); assert.deepEqual(t.daily.frozen,frozen);
  await human('phone wake', t.casual.phones['c-alice'], 'ooc'); assert.equal(t.daily.frozen,null); assert.equal(t.daily.anchor.minute,frozen.minute);
});
test('daily runtime: nighttime joining bypasses day pace; phone does not join', async () => {
  const {t,clock,human} = await setup();
  t.calendar.clock = 1380; t.timelines.main().clock = 1380;
  clock.t += 2*H; await t.clockTick({sparks:false});
  await human('phone',t.casual.phones['c-alice'],'ooc'); assert.equal(t.calendar.clock,1380);
  await human('I am here.'); assert.equal(t.calendar.date,'1923-10-03'); assert.equal(t.calendar.clock,420); assert.equal(t.daily.anchor,null);
  assert.ok(!t.isPassive('c-alice'));
});
test('daily runtime: GM date guard and final review do not bypass pace', async () => {
  const {t,clock} = await setup();
  assert.equal(t.moveCalendar({days:1,by:'keeper'}).pace,true);
  clock.t += 3*H;
  assert.equal(t.moveCalendar({days:2,time:'08:00',by:'keeper'}).days,1);
  assert.equal(t.moveCalendar({time:'07:00',by:'keeper'}).changed,false);
  await t.applyBetween({between:{advanceDays:4,time:'12:00',offscreen:[]},arc:{version:1}});
  assert.equal(t.calendar.date,'1923-10-03'); assert.equal(t.calendar.clock,480);
});
test('stand-ins: private witnessed context, typing hold, marked post, deferral and recall without rollback', async () => {
  const {t,api,llm,clock} = await setup();
  for (const m of [
    {content:'GM-SECRET',visibility:'gm_only',chat_window_id:'w-main'},
    {content:'OTHER-WHISPER',visibility:'whisper',whisper_to:['c-harriet'],chat_window_id:'w-main'},
    {content:'OTHER-WINDOW',visibility:'window',chat_window_id:'w-priv'},
    {content:'Alice, will you decide?',visibility:'window',chat_window_id:'w-main'},
  ]) t.noteLine(api.add({author_id:'u-bot',author_role:'gm',kind:'ic',...m}));
  clock.t += H; await t.reconcilePassive();
  assert.ok(t.isPassive('c-alice'));
  const visible = witnessedBy(t,'c-alice'); assert.ok(!JSON.stringify(visible).match(/GM-SECRET|OTHER-WHISPER|OTHER-WINDOW/));
  llm.standin = () => ({action:'speak',text:'Let me think about it.',defer:{question:'Join the club?',asked_by:'Harriet'}});
  t.typing.set('c-alice',{windowId:'w-main',since:clock.t}); assert.equal(await t.standinAct('w-main','c-alice'),0);
  t.typing.clear(); assert.equal(await t.standinAct('w-main','c-alice'),1);
  const line = api.lines.find(m => m.stand_in); assert.ok(line); assert.equal(t.daily.questions.length,1);
  const prompt = JSON.stringify(llm.calls.find(c => c.purpose==='standin_turn'));
  assert.ok(!prompt.match(/GM-SECRET|OTHER-WHISPER|OTHER-WINDOW|HIDDEN-TRUTH|SECRET-BOARD|SECRET-DOC/));
  assert.equal(await t.standinAct('w-main','c-alice'),0);
  await t.onRecalled({...line,channel_id:'ch',recalled_at:new Date(clock.t).toISOString()}); assert.equal(t.daily.questions.length,0);
  assert.equal(t.recordBond({a:'Alice Hale',b:'Harriet Vance',kind:'friendship'}),null);
});
test('away: owner phone only, ooc commands, phone does not clear passive, scene does', async () => {
  const {t,human,api,llm} = await setup();
  llm.awayRule = () => ({allow:['small talk'],forbid:['invitations'],maySpark:true});
  const phone = t.casual.phones['c-alice'];
  await human('/away I may start small talk',phone,'ooc'); assert.ok(t.isPassive('c-alice')); assert.ok(t.daily.rules['c-alice'].maySpark);
  await human('phone chatter',phone,'ooc'); assert.ok(t.isPassive('c-alice'));
  assert.equal(t.store.phoneOf('c-alice').length,0);
  await human('I take my seat.'); assert.ok(!t.isPassive('c-alice')); assert.equal(api.characters_[0].passive_since,null);
});
test('sparks: character first, GM last, unsafe actions dropped, bounded and interruptible', async () => {
  const {t,llm,api,clock} = await setup(); clock.t += 2*H; await t.clockTick({sparks:false});
  llm.coplayer = () => ({action:'speak',text:'Nice weather today.'});
  llm.director = () => ({actions:[{type:'bond',a:'Alice Hale',b:'Harriet Vance',kind:'love',text:'no'},{type:'date',advance_days:1},{type:'world_change',text:'no'},...Array.from({length:9},()=>({type:'narrate',text:'A breeze blows.'}))],topic:{state:'ended',title:'Weather'}});
  const start=api.posts.length; await t.turn('w-main',{mode:'spark',sparker:{id:'c-harriet',coplayer:t.roster.coplayers[0]}});
  const posts=api.posts.slice(start); assert.equal(posts[0].character_id,'c-harriet'); assert.equal(posts.at(-1).kind,'narration'); assert.ok(posts.length<=6); assert.equal(t.bonds.length,0);
  llm.coplayer = () => { t.dailyInterrupt=(t.dailyInterrupt??0)+1; return {action:'speak',text:'Must not post'}; };
  const n=api.posts.length; await t.turn('w-main',{mode:'spark',sparker:{id:'c-harriet',coplayer:t.roster.coplayers[0]}}); assert.equal(api.posts.length,n);
});

const settleAttention = async t => { for (let i = 0; i < 30 && t.pending; i++) { await new Promise(r => setTimeout(r, 2)); await t.queue; } assert.equal(t.pending, 0); };
const neglect = (t, api) => { for (let i = 0; i < 12; i++) t.noteLine(api.add({ chat_window_id: 'w-main', author_id: 'u-bot', author_role: 'gm', kind: 'narration', content: `Other people's conversation ${i}.` })); };

test('an unattended review uses one daily slot, opens only the co-player scene and keeps arrivals within the same safety and line budget', async () => {
  const { t, llm, api, clock } = await setup(); t.cfg.autonomy = true;
  neglect(t, api); clock.t += 2 * H; await t.clockTick({ sparks: false });
  t.timelines.main().location = 'Bookshop';
  const unsafe = [{ type: 'date', advance_days: 1 }, { type: 'bond', a: 'Alice Hale', b: 'Harriet Vance', kind: 'love', text: 'no' }, { type: 'world_change', text: 'no' }];
  llm.director = user => ({ actions: [...unsafe, ...(user.includes('MODE: attention') ? [{ type: 'narrate', text: 'Harriet has some photographs she wanted to develop.' }] : user.includes('MODE: arrival') ? [{ type: 'narrate', text: 'The developing tray is ready.' }] : [])],
    coplayers_may_act: false, whereabouts: user.includes('MODE: followup') ? [{ who: ['Alice Hale', 'Harriet Vance'], thread: 'new', place: 'Darkroom', own_scene: true }] : [] });
  let spoke = false;
  llm.coplayer = () => !spoke && (spoke = true) ? { action: 'speak', text: 'I go to Darkroom now.', needs_reply_from: ['Alice Hale'] } : { action: 'pass' };
  llm.movements = ({ actors, lines, destinations }) => ({ moves: actors.flatMap(a => {
    const own = lines.find(l => a.sources.includes(l.seq) && l.text === 'I go to Darkroom now.');
    return own ? [{ id: a.id, seq: own.seq, destination: destinations.find(d => d.place === 'Darkroom')?.key ?? 'NEW', place: 'Darkroom', own_scene: true }] : [];
  }) });
  const before = api.posts.length, date = t.calendar.date, slots = t.daily.sparks.length;
  t.sparkTick(); await settleAttention(t);
  assert.equal(t.daily.sparks.length, slots + 1);
  const scene = t.timelines.of('c-harriet'); assert.equal(scene.location, 'Darkroom');
  assert.deepEqual(scene.members, ['c-harriet']); assert.equal(t.timelines.of('c-alice').id, 'main');
  assert.ok(api.posts.slice(before).some(p => p.window === scene.windowId && p.content === 'The developing tray is ready.'));
  assert.ok(api.posts.length - before <= t.cfg.daily.spark_max_lines);
  assert.equal(t.calendar.date, date); assert.equal(t.bonds.length, 0);
  assert.ok(!llm.calls.some(c => c.purpose === 'standin_turn'));
  const arrival = llm.calls.find(c => c.purpose === 'director' && c.messages.at(-1).content.includes('MODE: arrival'));
  assert.match(arrival.messages.at(-1).content, /UNATTENDED PERSONAL SCENE/);
  assert.equal(t.daily.topics.main.open, false);
});

test('an unattended review discards a late GM response after player activity or budget exhaustion', async () => {
  for (const interrupt of ['human', 'budget']) {
    const { t, llm, api, clock } = await setup(); t.cfg.autonomy = true;
    neglect(t, api); clock.t += 2 * H; await t.clockTick({ sparks: false });
    llm.director = () => {
      if (interrupt === 'human') t.dailyInterrupt = (t.dailyInterrupt ?? 0) + 1;
      else t.overBudget = () => true;
      return { actions: [{ type: 'narrate', text: 'Late opportunity must not appear.' }] };
    };
    const before = api.posts.length;
    await t.turn('w-main', { mode: 'attention', gentle: true });
    assert.equal(api.posts.length, before);
    assert.equal(t.roster.coplayers[0].attention, undefined);
  }
});
test('unattended chatter uses at most two co-players and name mentions never summon a stand-in', async () => {
  const api=new FakeApi();
  for (const [i,name] of ['Tomas Leclerc','Mei Okada','Arthur Penhallow'].entries()) api.characters_.push({...structuredClone(api.characters_[1]),id:`c-peer${i}`,name});
  const {t,llm,clock}=await setup({api}); clock.t+=2*H; await t.clockTick({sparks:false});
  assert.equal(t.roster.coplayersIn('w-main').length,4);
  llm.coplayer=()=>({action:'speak',text:'Alice Hale once mentioned this recipe.'});
  llm.director=()=>({actions:[{type:'npc',name:'Mr. Grimsby',text:'Alice has tried it, too.'}],topic:{state:'ended'}});
  llm.standin=()=>({action:'speak',text:'This unsolicited agreement must never post.'});
  // A full story plan must not pressure an unattended exchange to open its next beat.
  t.plannerVerdict=()=>({on:true,moveOn:true,beat:'Lunch',next:'A secret revelation'});
  t.impulseFor=()=>({text:'PLOT-IMPULSE: press Alice to make a serious decision.'});
  const start=api.posts.length;
  await t.turn('w-main',{mode:'spark',sparker:{id:'c-harriet',coplayer:t.roster.coplayers[0]}});
  const coplayers=llm.calls.filter(c=>c.purpose==='coplayer_turn');
  assert.equal(coplayers.length,2); assert.equal(llm.calls.filter(c=>c.purpose==='standin_turn').length,0);
  assert.equal(api.posts.slice(start).filter(m=>m.stand_in).length,0);
  assert.equal(api.posts.at(-1).character_id,'c-butler');
  for(const call of coplayers) {
    assert.match(call.system,/own ordinary interests/);
    assert.doesNotMatch(call.messages[0].content,/PLOT-IMPULSE/);
  }
  const gm=llm.calls.find(c=>c.purpose==='director');
  assert.match(gm.messages[0].content,/PASSIVE CHARACTERS: Alice Hale remain quietly present/);
  assert.match(gm.messages[0].content,/THIS SMALL EXCHANGE: Harriet Vance and Mei Okada/);
  assert.match(gm.system,/No automatic response to every line/);
  assert.doesNotMatch(JSON.stringify(gm),/Bring it to a close now|open the next beat|Steer toward the current beat/);
});
test('a co-player direct request gets one stand-in answer and is not replayed next spark', async () => {
  const {t,llm,api,clock}=await setup(); clock.t+=2*H; await t.clockTick({sparks:false});
  llm.coplayer=()=>({action:'speak',text:'Alice, would you like a little tea?',needs_reply_from:['Alice Hale','Alice Hale']});
  llm.standin=()=>({action:'speak',text:'Just a little, thanks.'});
  llm.director=()=>({actions:[{type:'npc',name:'Mr. Grimsby',text:'I will pour it.'}],topic:{state:'ended'}});
  const start=api.posts.length;
  await t.turn('w-main',{mode:'spark',sparker:{id:'c-harriet',coplayer:t.roster.coplayers[0]}});
  assert.deepEqual(api.posts.slice(start).map(m=>m.character_id),['c-harriet','c-alice','c-butler']);
  assert.equal(api.posts.filter(m=>m.stand_in).length,1);
  const request=llm.calls.find(c=>c.purpose==='standin_turn');
  assert.match(request.messages[0].content,/CURRENT DIRECT REQUEST:\n\{"from":"Harriet Vance","text":"Alice, would you like a little tea\?"\}/);
  assert.match(request.system,/Quiet presence is the default/);
  llm.coplayer=()=>({action:'speak',text:'Alice likes this blend.'});
  await t.turn('w-main',{mode:'spark',sparker:{id:'c-harriet',coplayer:t.roster.coplayers[0]}});
  assert.equal(llm.calls.filter(c=>c.purpose==='standin_turn').length,1);
});
test('co-player requests cannot summon NPCs, co-players, unknown names or an off-scene passive PC', async () => {
  const {t,llm,api,clock}=await setup(); clock.t+=2*H; await t.clockTick({sparks:false});
  llm.director=()=>({actions:[],topic:{state:'ended'}});
  llm.coplayer=()=>({action:'speak',text:'Tea?',needs_reply_from:['Harriet Vance','Mr. Grimsby','Unknown','Alice',42]});
  const sparker={id:'c-harriet',coplayer:t.roster.coplayers[0]};
  await t.turn('w-main',{mode:'spark',sparker});
  const w=await api.createWindow('ch',{kind:'group',name:'Elsewhere',members:[{user_id:'u-alice',character_id:'c-alice'}]});
  t.timelines.split({name:'Elsewhere',members:['c-alice'],windowId:w.id,span:'long',fromSeq:api.seq+1});
  await t.refresh(); assert.ok(t.isPassive('c-alice')); assert.ok(!t.scene('w-main').members.includes('c-alice'));
  llm.coplayer=()=>({action:'speak',text:'Alice, tea?',needs_reply_from:['Alice Hale']});
  await t.turn('w-main',{mode:'spark',sparker});
  assert.equal(llm.calls.filter(c=>c.purpose==='standin_turn').length,0);
});
test('a passing spark starter ends quietly without other co-player, stand-in or GM calls', async () => {
  const api=new FakeApi(); api.characters_.push({...structuredClone(api.characters_[1]),id:'c-peer',name:'Tomas Leclerc'});
  const {t,llm,clock}=await setup({api}); clock.t+=2*H; await t.clockTick({sparks:false});
  llm.coplayer=()=>({action:'pass'}); const start=api.posts.length;
  await t.turn('w-main',{mode:'spark',sparker:{id:'c-harriet',coplayer:t.roster.coplayers[0]}});
  assert.equal(llm.calls.filter(c=>c.purpose==='coplayer_turn').length,1);
  assert.equal(llm.calls.filter(c=>['standin_turn','director'].includes(c.purpose)).length,0);
  assert.equal(api.posts.length,start); assert.equal(t.daily.topics[t.timelines.main().id].open,false);
});
test('a passive PC can still start small talk only with explicit permission', async () => {
  const {t,llm,api,clock}=await setup({daily:{pc_sparks:true}}); clock.t+=2*H; await t.clockTick({sparks:false});
  llm.standin=()=>({action:'speak',text:'The garden is lovely today.'});
  llm.coplayer=()=>({action:'speak',text:'The roses have opened.'});
  llm.director=()=>({actions:[{type:'narrate',text:'A breeze passes through the garden.'}],topic:{state:'ended'}});
  const sparker={id:'c-alice'};
  await t.turn('w-main',{mode:'spark',sparker});
  assert.equal(llm.calls.filter(c=>c.purpose==='standin_turn').length,0);
  t.daily.rules['c-alice']={maySpark:true,allow:['small talk'],forbid:[]}; const start=api.posts.length;
  await t.turn('w-main',{mode:'spark',sparker});
  assert.equal(llm.calls.filter(c=>c.purpose==='standin_turn').length,1);
  assert.equal(api.posts[start].character_id,'c-alice'); assert.equal(api.posts[start].stand_in,true);
  assert.equal(api.posts.at(-1).kind,'narration');
});
test('spark placement repair moves an already-departed co-player out before it can speak in the wrong scene', async () => {
  const {t,api,llm,clock}=await setup(); clock.t+=2*H; await t.clockTick({sparks:false});
  t.timelines.main().location='Bookshop';
  await t.post('w-main',{kind:'ic',character_id:'c-harriet',content:'I went home and am staying there for tea.'});
  const own=api.lines.at(-1);
  await t.post('w-main',{kind:'narration',content:'Harriet has returned to Hale house. Alice remains at the Bookshop.'});
  const confirmed=api.lines.at(-1);
  llm.presence=()=>({placements:[],departures:[{id:'c-harriet',actor_seq:own.seq,confirmation_seq:confirmed.seq,place:'Hale house',span:'long'}]});
  llm.coplayer=()=>({action:'speak',text:'GHOST-AT-BOOKSHOP'});
  await t.turn('w-main',{mode:'spark',sparker:{id:'c-harriet',coplayer:t.roster.coplayers[0]}});
  assert.notEqual(t.timelines.of('c-harriet').id,'main');
  assert.equal(t.timelines.of('c-harriet').location,'Hale house');
  assert.equal(llm.calls.filter(c=>c.purpose==='coplayer_turn').length,0);
  assert.ok(!api.posts.some(m=>m.content==='GHOST-AT-BOOKSHOP'));
});
test('spark presence checking respects token exhaustion and discards results when interrupted', async () => {
  for(const interrupt of [false,true]) {
    const {t,api,llm,clock}=await setup(); clock.t+=2*H; await t.clockTick({sparks:false});
    t.timelines.main().location='Bookshop';
    await t.post('w-main',{kind:'ic',character_id:'c-harriet',content:'I returned to Hale house.'}); const own=api.lines.at(-1);
    await t.post('w-main',{kind:'narration',content:'Harriet is at Hale house; Alice is at the Bookshop.'}); const confirmed=api.lines.at(-1);
    llm.presence=()=>{
      if(interrupt) t.dailyInterrupt=(t.dailyInterrupt??0)+1;
      return {placements:[],departures:[{id:'c-harriet',actor_seq:own.seq,confirmation_seq:confirmed.seq,place:'Hale house'}]};
    };
    if(!interrupt) t.cfg.dailyTokenBudget=1;
    await t.turn('w-main',{mode:'spark',sparker:{id:'c-harriet',coplayer:t.roster.coplayers[0]}});
    assert.equal(llm.calls.filter(c=>c.purpose==='scene_presence').length,1);
    assert.equal(llm.calls.filter(c=>['coplayer_turn','director','standin_turn'].includes(c.purpose)).length,0);
    if(interrupt) assert.equal(t.timelines.of('c-harriet').id,'main');
    else {
      assert.ok(t.overBudget()); const calls=llm.calls.length;
      await t.turn('w-main',{mode:'spark',sparker:{id:'c-harriet',coplayer:t.roster.coplayers[0]}});
      assert.equal(llm.calls.length,calls);
    }
  }
});
test('day summaries: only witnessed lines, phone GM posts, exact open questions and weekly routine', async () => {
  const {t,api,clock,llm} = await setup(); clock.t+=H; await t.reconcilePassive();
  t.noteLine(api.add({author_id:'u-bot',author_role:'gm',chat_window_id:'w-main',content:'A seat was saved for Alice.',kind:'narration'}));
  t.noteLine(api.add({author_id:'u-bot',author_role:'gm',chat_window_id:'w-main',content:'SECRET-SUMMARY',kind:'narration',visibility:'gm_only'}));
  t.daily.questions=[{id:'q',pc:'c-alice',text:'Tea tomorrow?',date:t.calendar.date,seq:api.seq,at:clock.t}];
  t.daily.week[3]='Wednesday classes';
  t.moveCalendar({days:1,time:'07:00',by:'operator'}); await t.flushDayTurns();
  const summaries=t.store.daySummaries('c-alice'); assert.equal(summaries.length,1);
  const last=api.posts.at(-1); assert.equal(last.window,t.casual.phones['c-alice']); assert.ok(last.content.endsWith('1. Tea tomorrow?')); assert.equal(last.character_id,undefined);
  assert.ok(!JSON.stringify(llm.calls.find(c=>c.purpose==='day_summary')).includes('SECRET-SUMMARY'));
  assert.equal(t.calendar.routine.text,'Wednesday classes');
});
test('hosting pause freezes the timetable; any normal human message resumes without elapsed pause time', async () => {
  const {t,api,clock,human}=await setup();
  const w=await api.createWindow('ch',{kind:'group',name:'Planner',members:[{user_id:'u-alice',character_id:'c-alice'}]});
  t.planner.window=w.id; await t.refresh(); clock.t+=2*H; await t.clockTick({sparks:false});
  await human('/pause',w.id,'ooc'); const frozen=structuredClone(t.daily.frozen); assert.ok(t.generation.paused);
  clock.t+=20*H; await t.clockTick({sparks:false}); assert.deepEqual(t.daily.frozen,frozen);
  await human('resume',t.casual.phones['c-alice'],'ooc'); assert.ok(!t.generation.paused); assert.equal(t.daily.anchor.minute,frozen.minute);
});
test('same-day GM time and whereabouts clocks cannot regress', async () => {
  const {t}=await setup();
  const moved=t.moveCalendar({time:'12:00',by:'keeper'}); assert.ok(moved.changed); assert.equal(t.calendar.clock,720);
  await t.act('w-main',{type:'time_skip',time:'11:59'},null,{mode:'human'}); assert.equal(t.timelines.main().clock,720);
  await t.act('w-main',{type:'timeline',timeline:'T0',narrative_time:'09:00'},null,{mode:'human'}); assert.equal(t.timelines.main().clock,720);
});
test('owner gates render only in enabled daily mode and include an expiry', async () => {
  const {t,clock}=await setup(); t.cfg.planner.enabled=true;
  t.planner.arc={mode:'full',beat:{title:'Club'},threads:[{id:'P1',title:'Club',status:'live',owners:['Alice Hale'],needs:'all'}]};
  clock.t+=H; await t.reconcilePassive(); assert.match(t.storyPlanSection(),/WAITS for Alice Hale/);
  clock.t+=7*DAY; assert.match(t.storyPlanSection(),/may advance/);
  t.cfg.daily.enabled=false; assert.ok(!t.storyPlanSection().includes('owners:'));
});
test('day turn rejoins short splits without arrival turns, leaving long splits intact', async () => {
  const {t,api}=await setup();
  const short=await api.createWindow('ch',{kind:'group',name:'Break room',members:[]});
  const long=await api.createWindow('ch',{kind:'group',name:'Travel',members:[{user_id:'u-alice',character_id:'c-alice'}]});
  const a=t.timelines.split({name:'Break',members:['c-harriet'],windowId:short.id,span:'short',fromSeq:api.seq+1});
  const b=t.timelines.split({name:'Travel',members:['c-alice'],windowId:long.id,span:'long',fromSeq:api.seq+1});
  await t.refresh(); t.checkInvariants();
  t.calendar.date='1923-10-03'; await t.dayTurn('1923-10-02',{timetable:true});
  assert.equal(t.timelines.get(a.id).status,'merged'); assert.equal(t.timelines.get(b.id).status,'active'); assert.equal(t.timers.size,0);
});
test('older platforms: status failure is logged once and no unmarked stand-in is attempted', async () => {
  const {t,clock,api}=await setup(); let attempts=0;
  api.setCharacterPresence=async()=>{attempts++;throw Object.assign(Error('old'),{status:404});};
  clock.t+=H; await t.reconcilePassive(); await t.reconcilePassive(); assert.equal(attempts,1);
  assert.equal(await t.standinAct('w-main','c-alice'),0);
});
test('questions are capped, explicitly cleared and expire by story date', async () => {
  const {t,api,llm,clock}=await setup(); clock.t+=H; await t.reconcilePassive();
  llm.standin=()=>({action:'speak',text:'Let me think.',defer:{question:'q'+api.seq,asked_by:'Harriet'}});
  for(let i=0;i<6;i++) { t.noteLine(api.add({chat_window_id:'w-main',author_id:'u-bot',kind:'ic',character_id:'c-harriet',content:'Alice?'})); await t.standinAct('w-main','c-alice'); }
  assert.equal(t.daily.questions.length,5);
  const id=t.daily.questions[0].id; await t.act('w-main',{type:'question_done',id},null,{mode:'human'}); assert.equal(t.daily.questions.length,4);
  t.calendar.date='1923-11-01'; await t.dayTurn('1923-10-31'); assert.equal(t.daily.questions.length,0);
});
test('open topics hold their clock; lag urges the GM and ended topics catch up', async () => {
  const {t,clock,llm}=await setup(); clock.t+=2*H; await t.clockTick({sparks:false});
  const sparker={id:'c-harriet',coplayer:t.roster.coplayers[0]};
  llm.coplayer=()=>({action:'speak',text:'The lunch queue is long.'});
  llm.director=()=>({actions:[{type:'narrate',text:'The bell rings.'}],topic:{state:'open',title:'Lunch'}});
  await t.turn('w-main',{mode:'spark',sparker}); const old=t.timelines.main().clock;
  clock.t+=2*H; await t.clockTick({sparks:false}); assert.equal(t.timelines.main().clock,old);
  await t.turn('w-main',{mode:'spark',sparker});
  assert.ok(llm.calls.filter(c=>c.purpose==='director').at(-1).messages[0].content.includes('finish this topic now'));
  assert.equal(t.timelines.main().clock,timetableAt(t.daily.anchor,clock.t,17).minute);
});
test('all autonomous sparks respect rolling caps, night and token pressure without disabling player replies', async () => {
  const {t,clock}=await setup(); clock.t+=2*H; await t.clockTick({sparks:false});
  let scheduled=0; t.schedule=()=>{scheduled++;};
  t.daily.sparks=Array(8).fill(clock.t-1); t.sparkTick(); assert.equal(scheduled,0);
  t.daily.sparks=[]; t.daily.anchor.minute=1380; t.sparkTick(); assert.equal(scheduled,0);
  t.daily.anchor.minute=600; t.cfg.dailyTokenBudget=100;
  const original=t.store.usageSince.bind(t.store); t.store.usageSince=()=>({input:60,output:0,cacheRead:0,cacheWrite:0});
  assert.equal(t.budgetPressure(),'tight'); t.sparkTick(); assert.equal(scheduled,1);
  t.daily.lastSparker=null; t.daily.nextSparkAt=0; t.store.usageSince=()=>({input:100,output:0,cacheRead:0,cacheWrite:0});
  assert.equal(t.budgetPressure(),'spent'); t.sparkTick(); assert.equal(scheduled,1);
  t.store.usageSince=original;
});
test('a slow away-rule reader cannot make a returned player passive again', async () => {
  const {t,llm,human}=await setup();
  const complete=llm.complete.bind(llm); let release, entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  llm.complete=async request=>{
    if(request.purpose==='away_rule') { entered(); await new Promise(resolve=>{release=resolve;}); }
    return complete(request);
  };
  const pending=human('/away Small talk is fine',t.casual.phones['c-alice'],'ooc');
  await waiting; assert.ok(t.isPassive('c-alice'));
  await human('I am back at the table.'); assert.ok(!t.isPassive('c-alice'));
  release(); await pending; assert.ok(!t.isPassive('c-alice'));
});
test('a follow-up spotlight gets one stand-in response without another GM loop', async () => {
  const {t,clock,llm,api}=await setup(); clock.t+=H; await t.reconcilePassive();
  llm.coplayer=()=>({action:'speak',text:'The tea is ready.'});
  let round=0;
  llm.director=()=>({actions:[{type:'narrate',text:++round===1?'The room is quiet.':'Alice, would you like tea?'}],coplayers_may_act:round===1,spotlight:round===1?[]:['Alice Hale']});
  llm.standin=()=>({action:'speak',text:'Yes, thank you.'});
  await t.turn('w-main',{mode:'quiet'});
  assert.equal(api.lines.filter(m=>m.stand_in).length,1);
  assert.equal(llm.calls.filter(c=>c.purpose==='director').length,2);
});
test('a real human event cancels an in-flight spark before it posts', async () => {
  const {t,clock,llm,human,api}=await setup(); clock.t+=2*H; await t.clockTick({sparks:false});
  const complete=llm.complete.bind(llm); let release, entered, held=false;
  const waiting=new Promise(resolve=>{entered=resolve;});
  llm.complete=async request=>{
    if(request.purpose==='coplayer_turn'&&!held) { held=true; entered(); await new Promise(resolve=>{release=resolve;}); return JSON.stringify({action:'speak',text:'CANCELLED-SPARK'}); }
    return complete(request);
  };
  const spark=t.schedule('w-main',{mode:'spark',delay:0,sparker:{id:'c-harriet',coplayer:t.roster.coplayers[0]}});
  await waiting; const reply=human('I am here now.'); release(); await Promise.all([spark,reply]);
  assert.ok(!api.posts.some(m=>m.content==='CANCELLED-SPARK')); assert.equal(t.dailyMode(),'attended');
});
test('operator day changes queue every crossed date durably', async () => {
  const {t}=await setup(); t.cfg.daily.summaries=false;
  t.moveCalendar({days:3,time:'07:00',by:'operator'});
  assert.deepEqual(t.daily.pendingDays.map(e=>e.endedDate),['1923-10-02','1923-10-03','1923-10-04']);
  t.daily.week[5]='Friday routine'; await t.flushDayTurns();
  assert.equal(t.daily.pendingDays.length,0); assert.equal(t.calendar.routine.text,'Friday routine');
});
test('late stand-in recall removes derived summaries and memory without reverting the world', async () => {
  const {t,llm,clock,api}=await setup(); clock.t+=H; await t.reconcilePassive();
  llm.standin=()=>({action:'speak',text:'RECALLED-REPLY',defer:{question:'RECALLED-QUESTION',asked_by:'Harriet'}});
  await t.standinAct('w-main','c-alice'); const line=api.lines.find(m=>m.stand_in);
  t.store.addChapter({scope:'gm',windowId:'w-main',fromSeq:line.seq,toSeq:line.seq,text:'RECALLED-MEMORY'});
  await t.dayTurn(t.calendar.date);
  assert.equal(t.store.daySummaries('c-alice').length,1);
  const date=t.calendar.date;
  await t.onRecalled({...line,channel_id:'ch',recalled_at:new Date(clock.t).toISOString()});
  assert.equal(t.calendar.date,date); assert.equal(t.daily.questions.length,0);
  assert.equal(t.store.daySummaries('c-alice').length,0); assert.equal(t.store.chapters('gm','w-main').length,0);
  assert.ok(!JSON.stringify(witnessedBy(t,'c-alice')).match(/RECALLED-REPLY|RECALLED-QUESTION|You spent time/));
  const prompt=await t.buildGm('w-main'); assert.ok(!prompt.text.includes('RECALLED-MEMORY'));
});
test('an in-flight compaction cannot restore a recalled stand-in to memory', async () => {
  const {t,llm,api}=await setup();
  const line=api.add({author_id:'u-bot',character_id:'c-alice',stand_in:true,kind:'ic',content:'BEFORE-RECALL',chat_window_id:'w-main'}); t.noteLine(line);
  const complete=llm.complete.bind(llm); let release, entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  llm.complete=async request=>{
    if(request.purpose==='compact') { entered(); await new Promise(resolve=>{release=resolve;}); }
    return complete(request);
  };
  const job=t.memory.maintainGm('w-main',t.history.lines('w-main'),m=>m.content,{whole:true});
  await waiting; await t.onRecalled({...line,channel_id:'ch',recalled_at:new Date().toISOString()}); release(); await job;
  assert.equal(t.store.chapters('gm','w-main').length,0);
});
test('pause interrupts a pending model immediately and durably freezes its clock', async () => {
  const {t,clock,llm,human,api}=await setup();
  const planner=await api.createWindow('ch',{kind:'group',name:'Planner',members:[{user_id:'u-alice',character_id:'c-alice'}]});
  t.planner.window=planner.id; await t.refresh(); clock.t+=2*H; await t.clockTick({sparks:false});
  const complete=llm.complete.bind(llm); let release, entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  llm.complete=async request=>{
    if(request.purpose==='coplayer_turn') { entered(); await new Promise(resolve=>{release=resolve;}); }
    return complete(request);
  };
  const spark=t.schedule('w-main',{mode:'spark',delay:0,sparker:{id:'c-harriet',coplayer:t.roster.coplayers[0]}});
  await waiting; const paused=human('/pause',planner.id,'ooc');
  assert.ok(t.generation.paused); assert.equal(t.daily.anchor,null); const frozen=structuredClone(t.daily.frozen);
  clock.t+=H; release(); await Promise.all([spark,paused]); assert.deepEqual(t.daily.frozen,frozen);
  assert.ok(!api.posts.some(m=>m.character_id==='c-harriet'));
});
test('daily planner: one lightweight call per unattended story date, persisted across restart', async () => {
  const {t,clock,llm,api}=await setup(); t.cfg.planner.enabled=true;
  t.planner.arc={version:7,threads:[{id:'P1',owners:['Alice Hale'],needs:'all',twist:'A secret meeting behind the old library'}],beat:{title:'Wait',closed:false},verdict:{moveOn:false}};
  t.daily.week[2]='Tuesday classes';
  const before=structuredClone(t.planner.arc);
  llm.dailyPlanner=()=>({routine:'Classes, lunch and ordinary club time.',topics:['A favourite lunch','Autumn colours']});
  clock.t+=2*H; await t.clockTick({sparks:false});
  assert.equal(llm.calls.filter(c=>c.purpose==='planner_daily').length,1);
  assert.equal(llm.calls.filter(c=>c.purpose==='planner').length,0);
  assert.equal(t.daily.planAttempt.status,'ready'); assert.equal(t.calendar.routine.text,'Classes, lunch and ordinary club time.');
  assert.deepEqual(t.planner.arc,before); assert.equal(t.bonds.length,0);
  const prompt=JSON.stringify(llm.calls.find(c=>c.purpose==='planner_daily'));
  assert.match(prompt,/Tuesday classes/); assert.ok(!prompt.match(/HIDDEN-TRUTH|SECRET-BOARD|secret meeting|Alice Hale|GM-SECRET/));
  assert.match(t.sparkNote('w-main').text,/A favourite lunch/);
  t.daily.topics[t.timelines.main().id]={open:true,title:'Ongoing chat',sparks:1};
  assert.ok(!t.sparkNote('w-main').text.includes('Optional daily-life')); t.daily.topics={};
  await t.clockTick({sparks:false}); assert.equal(llm.calls.filter(c=>c.purpose==='planner_daily').length,1);
  const restarted=await setup({state:{daily:structuredClone(t.daily),calendar:structuredClone(t.calendar),timelines:t.timelines},clock,api});
  restarted.t.cfg.planner.enabled=true; await restarted.t.clockTick({sparks:false});
  assert.equal(restarted.llm.calls.filter(c=>c.purpose==='planner_daily').length,0);
  clock.t+=17*H; await restarted.t.clockTick({sparks:false});
  assert.equal(restarted.llm.calls.filter(c=>c.purpose==='planner_daily').length,1);
  assert.equal(restarted.t.daily.dayPlan.date,'1923-10-03');
  assert.ok(t.store.usageByPurpose().some(u=>u.purpose==='planner_daily'&&u.calls===1));
});
test('daily planner: spent budget defers the day, tight budget trims it, no catch-up replay', async () => {
  const {t,clock,llm}=await setup(); t.cfg.planner.enabled=true; t.cfg.daily.summaries=false;
  clock.t+=2*H; t.cfg.dailyTokenBudget=1000;
  t.store.recordUsage({at:clock.t,purpose:'test',input:1000}); await t.clockTick({sparks:false});
  assert.equal(t.daily.planAttempt,null); assert.equal(llm.calls.filter(c=>c.purpose==='planner_daily').length,0);
  t.cfg.dailyTokenBudget=1600;
  llm.dailyPlanner=()=>({routine:'x'.repeat(500),topics:['a'.repeat(200),'b','c','d']});
  await t.clockTick({sparks:false}); assert.equal(t.daily.dayPlan.topics.length,2); assert.equal(t.daily.dayPlan.topics[0].length,100); assert.equal(t.daily.dayPlan.routine.length,240);
  assert.match(llm.calls.find(c=>c.purpose==='planner_daily').system,/at most 2 very short/);
  t.cfg.dailyTokenBudget=0; clock.t+=3*17*H; await t.clockTick({sparks:false});
  assert.equal(llm.calls.filter(c=>c.purpose==='planner_daily').length,2);
  assert.equal(t.daily.dayPlan.date,'1923-10-05');
});
test('daily planner: gated by daily mode, planner switch, hosting pause and seven-day freeze', async () => {
  const {t,clock,llm}=await setup(); t.cfg.planner.enabled=true;
  await t.clockTick({sparks:false}); assert.equal(t.daily.planAttempt,null);
  clock.t+=2*H; t.cfg.planner.enabled=false; await t.clockTick({sparks:false}); assert.equal(t.daily.planAttempt,null);
  t.cfg.planner.enabled=true; t.cfg.daily.enabled=false; await t.clockTick({sparks:false}); assert.equal(t.daily.planAttempt,null);
  t.cfg.daily.enabled=true; t.generation.pause(); await t.clockTick({sparks:false}); assert.equal(t.daily.planAttempt,null);
  t.generation.resume(); clock.t+=8*DAY; await t.clockTick({sparks:false}); assert.equal(t.daily.planAttempt,null);
  assert.equal(llm.calls.filter(c=>c.purpose==='planner_daily').length,0);
});
test('daily planner rejects plot mutation fields and does not retry malformed output all day', async () => {
  const {t,clock,llm}=await setup(); t.cfg.planner.enabled=true;
  t.calendar.routine={text:'Existing routine',upcoming:[]};
  llm.dailyPlanner=()=>({routine:'New routine',topics:[],threads:[{id:'P1',status:'resolved'}],between:{advance_days:7}});
  clock.t+=2*H; await t.clockTick({sparks:false}); await t.clockTick({sparks:false});
  assert.equal(t.daily.planAttempt.status,'failed'); assert.equal(t.calendar.routine.text,'Existing routine');
  assert.equal(llm.calls.filter(c=>c.purpose==='planner_daily').length,1); assert.equal(t.calendar.date,'1923-10-02');
  clock.t+=17*H; llm.dailyPlanner=()=>({routine:'HIDDEN-TRUTH',topics:[]}); await t.clockTick({sparks:false});
  assert.equal(t.daily.planAttempt.status,'failed'); assert.equal(t.daily.dayPlan,null);
});
test('daily planner discards a response when a player joins during the call', async () => {
  const {t,clock,llm,human}=await setup(); t.cfg.planner.enabled=true; t.cfg.planner.intervalMs=0;
  clock.t+=2*H; const complete=llm.complete.bind(llm); let release,entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  llm.complete=async request=>{if(request.purpose==='planner_daily'){entered();await new Promise(resolve=>{release=resolve;});}return complete(request);};
  const tick=t.queue=t.clockTick({sparks:false}); await waiting;
  const reply=human('I return to class.'); release(); await Promise.all([tick,reply]);
  assert.equal(t.daily.planAttempt.status,'discarded'); assert.equal(t.daily.dayPlan,null);
});
test('daily planner defers to an active full plan and does not trigger full plans on unattended phone activity', async () => {
  const {t,clock,llm}=await setup(); t.cfg.planner.enabled=true; clock.t+=2*H;
  t.memory.jobs.set('planner',Promise.resolve()); await t.clockTick({sparks:false});
  assert.equal(t.daily.planAttempt,null); t.memory.jobs.delete('planner');
  await t.clockTick({sparks:false}); assert.equal(t.daily.planAttempt.status,'ready');
  t.lastHumanAt=clock.t; t.planner.asked={why:'phone',at:clock.t};
  assert.equal(t.maybePlan(),null); assert.equal(llm.calls.filter(c=>c.purpose==='planner').length,0);
});
