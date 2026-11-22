import fs from 'node:fs';
import { Store, billableTokens } from '../store.mjs';
import { createModels } from '../llm/index.mjs';
import { metered } from '../llm/parts.mjs';
import { usageSink } from '../usage.mjs';
import { Realtime } from '../realtime.mjs';
import { rulesProfile } from '../rules/index.mjs';
import { loadState, saveState } from '../state.mjs';
import { writeWorldbookTexts } from '../table/worldbook.mjs';
import { newSession, SESSION_KEY, fact, join, acceptAnswer, approve, allApproved, publicDossier, status, hash } from './state.mjs';
import { controlsCard, questionCard, command, bindingFor, CONTROL_LIFETIME_SECONDS } from './cards.mjs';
import { interview, compile, secrets, playtest } from './design.mjs';
import { createSeed, importSeed } from './seed.mjs';
import { applyCandidate } from './apply.mjs';
export function forgeMode(cfg,state) {
  if(state?.forge?.phase==='playing') return false;
  const requested=Boolean(cfg.forge?.enabled || state?.forge);
  if(requested && !(cfg.improv ?? state?.improv?.on ?? Boolean(cfg.worldFile))) throw Error('Forge 只能在即兴模式下启用，请开启 modes.improv。');
  return requested;
}
export function budgeted(llm,store,cfg,signal) {
  return { complete: async req => {
    signal?.throwIfAborted();
    const day=new Date(); day.setHours(0,0,0,0);
    if(cfg.dailyTokenBudget>0 && billableTokens(store.usageSince(day.getTime()))>=cfg.dailyTokenBudget) throw Error('今日模型预算已用完，草案已保留，预算恢复后可继续。');
    return llm.complete({...req,signal});
  }, signalOf:()=>signal };
}
const chunks = value => String(value).match(/[\s\S]{1,3500}/g) ?? [];
export class Forge {
  constructor({api,cfg,channel,store,llm,savePointer=()=>{},onStart=()=>{},log=()=>{}}) {
    Object.assign(this,{api,cfg,channel,channelId:channel.id,store,llm,savePointer,onStart,log});
    this.language=cfg.language || 'Simplified Chinese'; this.queue=Promise.resolve(); this.windows=[]; this.characters=[];
    this.planner={on:false,table:[]}; this.improv={on:true}; this.casual={on:false}; this.roster={coplayers:[],npcs:[]}; this.generation={paused:true};
    this.s=store.get(SESSION_KEY,null);
  }
  save() { this.store.set(SESSION_KEY,this.s); this.forge=status(this.s); this.savePointer(this.s); }
  async say(content) { for(const part of chunks(content)) await this.api.postMessage(this.channelId,this.s.window,{kind:'ooc',content:part}); }
  async card(body) {
    try { const binding=bindingFor(this.s,body); const row=await this.api.postHypertext(this.channelId,this.s.window,body); this.s.cards.push(row.id); (this.s.bindings??={})[row.id]=binding; this.save(); }
    catch(e) { if([400,404,405,429].includes(e.status) || e.code==='feature_disabled') await this.say(body.content); else throw e; }
  }
  async controls(audience) {
    await this.card(controlsCard(this.s,audience));
    this.s.controlsUntil=Date.now()+CONTROL_LIFETIME_SECONDS*1000; this.save();
  }
  async showDraft() {
    if(!this.s.candidate) throw Error('请先生成草案。');
    await this.say(`完整草案 v${this.s.revision}\n${this.s.candidate.world}\n\n开局条件\n${this.s.candidate.opening}`);
    if(this.s.candidate.pack) await this.say('共同生成的 PbtA 规则与 playbook\n'+JSON.stringify(this.s.candidate.pack,null,2));
    for(const c of this.s.candidate.characters) {
      const before=c.existing_id && this.s.existing?.find(x=>x.id===c.existing_id);
      if(before) await this.say(`现有角色 · ${before.name} · 修改前\n${before.bio}\n${JSON.stringify(before.role_card,null,2)}`);
      await this.say(`${c.key} · ${c.name} · ${c.kind==='player'?this.s.participants[c.owner_user_id].name:'NPC'}${c.existing_id?'（修改后）':''}\n${c.persona}\n表达方式：${c.speaking_style}\n外观：${c.appearance_prompt}\n${JSON.stringify(c.role_card,null,2)}`);
    }
  }
  async closeCards() { const ids=this.s.cards.splice(0); this.s.controlsUntil=0; this.save(); for(const id of ids) try {await this.api.closeHypertext(this.channelId,id);} catch(e) {this.log(`Forge card close: ${e.message}`);} }
  async init() {
    if(!this.channel.forge_eligible) throw Error('Forge 只能在正式剧情开始前使用。进行中的修改请在即兴模式下致剧情规划。');
    if(!this.s) {
      const read=file=>file?fs.readFileSync(file,'utf8').trim():'';
      this.s=newSession({world:read(this.cfg.worldFile),secrets:read(this.cfg.secretsFile),rule:this.channel.rule_system,source:this.cfg.worldFile});
      if(this.s.sourceWorld.length>30000 || this.s.sourceSecrets.length>20000) throw Error('输入世界或秘密超过长度限制。');
      if(this.s.sourceWorld) fact(this.s,'F',this.s.sourceWorld,'source'); this.save();
    }
    if(this.s.rule!==this.channel.rule_system) throw Error('频道规则已改变，请恢复筹备使用的规则。');
    const members=(await this.api.channelMembers(this.channelId)).map(m=>({...m,user_id:m.user_id??m.id}));
    if(!this.s.window) {
      this.s.windowIntent??={name:'开局共创 · Forge',kind:'group',purpose:'forge',request_id:`forge:${this.s.id}:window`,members:members.filter(m=>['player','gm'].includes(m.role)&&m.user_id!==this.api.user.id).map(m=>({user_id:m.user_id}))}; this.save();
      this.s.window=(await this.api.createWindow(this.channelId,this.s.windowIntent)).id; this.save();
    }
    this.windows=await this.api.windows(this.channelId);
    this.characters=await this.api.characters(this.channelId);
    try { await this.syncInvitations(members); } catch(e) { this.log(`Forge invitation: ${e.message}`); this.s.error=e.message; this.save(); }
  }
  async syncInvitations(members) {
    const audience=members.filter(m=>['player','gm'].includes(m.role) && m.user_id!==this.api.user.id).map(m=>m.user_id);
    const seated=new Set(audience.length ? (await this.api.windowMembers(this.channelId,this.s.window)).map(m=>m.user_id) : []);
    // Only count an invitation delivered if the player was in the window when it was posted.
    const delivered=(this.s.invitedMembers??[]).filter(id=>audience.includes(id) && seated.has(id));
    if (delivered.length!==(this.s.invitedMembers??[]).length) { this.s.invitedMembers=delivered; this.save(); }
    if (!audience.length || !this.s.welcomed && !members.some(m=>m.role==='player' && m.user_id!==this.api.user.id)) return;
    if (audience.every(id=>delivered.includes(id)) && this.s.controlsUntil>Date.now()) return;
    for(const id of audience) if(!seated.has(id)) await this.api.addWindowMember(this.channelId,this.s.window,{user_id:id});
    if(!this.s.welcomed) {
      await this.say('这里是开局共创。先加入，再回答每轮少量问题；也可以直接写想法。所有参与者确认同一份世界、规则和自己的角色后，才会启用。筹备可随时保存，正式开局另行确认。');
      this.s.welcomed=true; this.save();
    }
    await this.controls(audience);
    this.s.invitedMembers=audience; this.save();
  }
  enqueue(fn) { this.queue=this.queue.then(fn).catch(async e=>{this.log(`Forge: ${e.message}`);if(this.stopped){this.forge.error=e.message;return;}this.s.error=e.message;this.save(); if(e.fromForgeMessage) try{await this.say(`筹备已保留：${e.message}`);await this.controls();}catch{}}); return this.queue; }
  async catchup() {
    if(!this.s.window || this.stopped) return;
    const members=(await this.api.channelMembers(this.channelId)).map(m=>({...m,user_id:m.user_id??m.id}));
    await this.syncInvitations(members);
    const found=[]; let before=0;
    for(;;) {
      const page=await this.api.messages(this.channelId,this.s.window,100,before);
      const rows=Array.isArray(page)?page:page.messages ?? [];
      const fresh=rows.filter(m=>m.seq>this.s.cursor); found.push(...fresh);
      if(rows.length<100 || fresh.length<rows.length || !rows.length) break;
      const next=Math.min(...rows.map(m=>m.seq)); if(before&&next>=before) break; before=next;
    }
    for(const m of found.sort((a,b)=>a.seq-b.seq)) { if(this.stopped) break; try { await this.message(m); } catch(e) { e.fromForgeMessage=true; throw e; } }
  }
  async message(m) {
    if(m.chat_window_id!==this.s.window || m.seq<=this.s.cursor || this.stopped) return;
    this.s.cursor=m.seq; this.save();
    if(m.recalled_at || m.author_id===this.api.user.id || !['ooc','ic'].includes(m.kind) || m.visibility!=='window') return;
    const members=(await this.api.channelMembers(this.channelId)).map(m=>({...m,user_id:m.user_id??m.id}));
    const member=members.find(x=>x.user_id===m.author_id && ['player','gm'].includes(x.role)); if(!member) return;
    let raw=String(m.content??'').trim();
    if(m.via_hypertext_id) {
      const binding=this.s.bindings?.[m.via_hypertext_id];
      const joinFromInvite=binding?.actions?.[raw]==='join' && this.s.phase==='interview';
      if(!binding || binding.revision!==this.s.revision && !joinFromInvite) {await this.say('这张卡片已过期，请使用当前版本。');await this.controls();return;}
      const action=binding.question && raw.startsWith(binding.prefix) ? `answer ${binding.question} ${raw.slice(binding.prefix.length)}` : binding.actions?.[raw];
      if(!action) return;
      raw=command(this.s,action);
    }
    const match=raw.match(/^\/forge ([a-z0-9-]+) (\d+) (\w+)(?: ([\s\S]*))?$/);
    const pendingJoin=match?.[3]==='join' && this.s.phase==='interview' && !this.s.participants[member.user_id] && Number(match[2])>0 && Number(match[2])<this.s.revision;
    if(raw.startsWith('/forge') && (!match || match[1]!==this.s.id || Number(match[2])!==this.s.revision && !pendingJoin)) {await this.say('这条操作来自旧版草案，请使用下方当前版本。');await this.controls();return;}
    let action=match?.[3]??'answer', value=match?.[4]??raw;
    this.s.error=null;
    if(action==='save') {this.save();await this.say('草案已保存。');return;}
    if(action==='cancel') {if(['applying','ready'].includes(this.s.phase)) throw Error('启用已开始，请完成后再开局。');this.s.resumePhase=this.s.phase;this.s.phase='cancelled';this.save();await this.controls();return;}
    if(action==='resume' && this.s.phase==='cancelled') {this.s.phase=this.s.resumePhase??'interview';this.save();await this.controls();return;}
    if(this.s.phase==='cancelled') throw Error('筹备已暂停，请先继续筹备。');
    if(action==='join') {if(join(this.s,member)){this.save();await this.controls([]);}return;}
    if(!this.s.participants[member.user_id] && member.role!=='gm') throw Error('请先加入共创。');
    if(action==='view') {await this.showDraft();return;}
    if(action==='answer') {
      const q=this.s.questions.find(q=>value.startsWith(q.id+' '));
      if(q) value=`${q.text}\n${value.slice(q.id.length+1)}`;
      if(!value.trim()) return;
      acceptAnswer(this.s,member.user_id,value);this.save();await this.controls();return;
    }
    if(action==='next' || action==='compile') {
      if(this.s.phase!=='interview' && this.s.phase!=='review') throw Error('当前阶段不能重新生成草案。');
      if(!Object.keys(this.s.participants).length) throw Error('请至少一位玩家加入共创。');
      await this.closeCards();
      if(action==='next') {
        if(this.s.candidate) (this.s.drafts??=[]).push({revision:this.s.revision,candidate:this.s.candidate,approvals:this.s.approvals});
        this.s.revision++;this.s.approvals={};this.s.candidate=null;this.s.phase='interview';this.save();
        const questions=await interview(this.llm,this.s,this.language);
        this.s.questions=questions.map(q=>({...q,id:fact(this.s,'Q',q.text).id}));this.save();
        for(const [i,q] of this.s.questions.entries()) await this.card(questionCard(this.s,q,i));
      } else {
        const rules=await rulesProfile(this.s.rule).fetchRules(this.api,this.channelId);
        const existing=await this.api.characters(this.channelId);
        this.s.existing=existing.map(c=>({id:c.id,name:c.name,kind:c.kind,user_id:c.user_id,updated_at:c.updated_at,role_card:c.role_card,bio:c.bio,appearance_prompt:c.appearance_prompt}));
        // The model only sees public fields. NPC secrets are never taken from platform sheets for the interview.
        const publicExisting=this.s.existing.filter(c=>c.kind==='pc').filter(c=>this.s.participants[c.user_id]||c.user_id===this.api.user.id);
        const candidate=await compile(this.llm,this.s,{language:this.language,rules,existing:publicExisting,cfg:this.cfg,api:this.api,channel:this.channel});
        if(this.s.candidate) (this.s.drafts??=[]).push({revision:this.s.revision,candidate:this.s.candidate,approvals:this.s.approvals});
        this.s.revision++;this.s.approvals={};this.s.candidate=candidate;this.s.packRevision=rules.revision;
        this.s.phase='review';this.s.privateWorld=null;this.s.worldStateSeed=null;this.save();
        await this.showDraft();
      }
      await this.controls();return;
    }
    if(action==='approve') {approve(this.s,member.user_id,this.s.revision);this.save();await this.say(`已确认 ${Object.keys(this.s.approvals).length}/${Object.keys(this.s.participants).length}。`);if(allApproved(this.s)) await this.controls();return;}
    if(action==='test') {if(this.s.phase!=='review') throw Error('请先生成草案。');const result=await playtest(this.llm,this.s,value);(this.s.playtests??=[]).push(result);this.save();await this.say('独立试跑已结束；报告可在 GM 托管界面查看，未改变正式故事。');return;}
    if(action==='apply') {
      if(!['review','applying'].includes(this.s.phase)||!allApproved(this.s)) throw Error('请所有参与者先确认当前版本。');
      for(const u of Object.keys(this.s.participants)) if(!members.some(m=>m.user_id===u&&['player','gm'].includes(m.role))) throw Error('有参与者已离开频道，请恢复成员身份后继续。');
      if(!this.s.privateWorld) {this.s.privateWorld=await secrets(this.llm,this.s,this.language);this.save();}
      if(!this.s.worldStateSeed) {this.s.worldStateSeed=await createSeed(this.llm,this.s);this.save();}
      await applyCandidate({api:this.api,channel:this.channel,session:this.s,save:()=>this.save(),gmId:this.api.user.id});
      await this.closeCards();await this.say('设定和角色已准备好。选择“开始正式游戏”后进入故事。');await this.controls();return;
    }
    if(action==='start') {
      if(this.s.phase!=='ready'||!allApproved(this.s)) throw Error('请先确认并启用草案。');
      await this.closeCards(); await this.onStart(this.s); return;
    }
    throw Error('无法识别的筹备操作。');
  }
}
export async function startForge({cfg,api,channel,release,managed,run,log}) {
  const store=Store.open(cfg.stateDir,channel.id), abort=new AbortController();
  const llm=budgeted(metered(createModels(cfg),{sink:usageSink(store,log),channelId:channel.id,log}),store,cfg,abort.signal);
  let next=null,rt,timer,transition=null,stopping=false;
  const writePointer=s=>{const state=loadState(cfg.stateDir,channel.id)??{channelId:channel.id,serverId:channel.server_id};state.forge={id:s.id,revision:s.revision,phase:s.phase};saveState(cfg.stateDir,state);};
  const table=new Forge({api,cfg,channel,store,llm,log,savePointer:writePointer,onStart:async s=>{
    if(!(await api.channel(channel.id)).forge_eligible) throw Error('正式剧情已开始，不能从筹备覆盖它。');
    let state=loadState(cfg.stateDir,channel.id)??{channelId:channel.id,serverId:channel.server_id};
    state=importSeed(state,s,await api.characters(channel.id));
    state.improv={on:true,world:s.candidate.world+'\n\n开局条件\n'+s.candidate.opening,secrets:s.privateWorld,truths:[]};
    // Forge skips ordinary setup/card generation; carry the selected casual mode into play here.
    if(cfg.casual!==undefined) state.casual={...(state.casual??{}),on:cfg.casual};
    try{state.improv.book=writeWorldbookTexts(cfg.stateDir,channel.id,state.improv,'forge');}catch(e){log('worldbook: '+e.message);}
    state.forge={id:s.id,revision:s.revision,phase:'playing',characterIds:s.characterIds};state.pbtaSetup={ready:true};saveState(cfg.stateDir,state);
    s.phase='playing';store.set(SESSION_KEY,s);table.forge=status(s);table.stopped=true;
    clearInterval(timer);rt?.stop();release();store.close();
    transition=run({...cfg,worldFile:null,secretsFile:null,improv:true,prepareOnStart:false,kickoff:true},{managed:true}).catch(e=>{
      table.forge.error='正式主持启动失败，请在托管界面重启：'+e.message;log(table.forge.error);return null;
    });next=await transition;
    if(stopping && next) await next.stop();
  }});
  try{await table.init();}catch(e){store.close();release();throw e;}
  rt=new Realtime({apiBase:cfg.apiBase,token:()=>api.token,reauth:()=>api.relogin(),channelId:channel.id,streams:['chat'],log});
  rt.on('event',ev=>{if(ev.type==='message.posted'&&ev.message.chat_window_id===table.s.window) table.enqueue(()=>table.catchup());});
  rt.on('subscribed',()=>table.enqueue(()=>table.catchup()));rt.start();
  timer=setInterval(()=>table.enqueue(()=>table.catchup()),10000);
  const runtime={get table(){return next?.table??table;},get channel(){return next?.channel??channel;},get realtime(){return next?.realtime??rt;},cfg,
    stop:async()=>{stopping=true;if(transition){await transition;return next?.stop();}table.stopped=true;abort.abort();clearInterval(timer);rt.stop();await table.queue;store.close();release();}};
  if(!managed){const stop=()=>runtime.stop().finally(()=>process.exit(0));process.once('SIGINT',stop);process.once('SIGTERM',stop);}
  return runtime;
}
