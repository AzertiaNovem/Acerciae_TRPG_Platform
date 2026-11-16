import { completeText, completeJson } from '../llm/index.mjs';
import { rulesProfile } from '../rules/index.mjs';
import { validatePack, validateActor } from '../pbta-validation.mjs';
import { publicDossier } from './state.mjs';
import { allocatePointBuy } from '../roles/pointbuy.mjs';
const text = (v, max, name) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw Error(`${name}: expected text up to ${max} characters`); return v; };
const castShape = `{key:"C1",kind:"player|coplayer|npc",owner_user_id:"a participating user ID for player only",existing_id:"only if editing an existing character",expected_updated_at:"existing character version",name,persona,speaking_style,appearance_prompt,role_card}`;
export async function interview(llm, s, language) {
  const prose = await completeText(llm, { purpose: 'forge_interview', system: `You are a pre-game collaborative story designer. Write plain text in ${language}. Ask only 2–3 focused questions with 2–3 concrete, evocative options each. Begin with the players' desired characters, motives, relationships, romance boundaries, challenge and tone; then fill world gaps. An immature source is a starting point, never a fixed plot. Reconcile different players' wishes with a playable compromise, but leave final acceptance to them. Distinguish accepted answers, proposals, rejected facts, and open questions. Never reveal or invent hidden truth in the public interview. Do not begin play.`, user: JSON.stringify(publicDossier(s)) });
  return completeJson(llm, { purpose: 'forge_format', system: 'Extract these interview questions without adding facts. Return {"questions":[{"text":"question","options":["option","option"]}]}. 2–3 questions; 2–3 options each, options <=120 characters.', user: prose }, x => {
    if (!Array.isArray(x.questions) || x.questions.length < 2 || x.questions.length > 3) throw Error('Need 2–3 questions');
    for (const q of x.questions) { text(q.text, 1600, 'question'); if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 3) throw Error('Need 2–3 options'); q.options.forEach(o => text(o,120,'option')); }
    return x.questions;
  });
}
export function validateCandidate(x, s) {
  text(x.world,25000,'public world'); text(x.opening,4000,'opening conditions');
  if (!Array.isArray(x.characters) || x.characters.length > 32) throw Error('Need a cast of at most 32');
  const keys = new Set(); const owned = new Set();
  for (const c of x.characters) {
    if (!/^C[1-9][0-9]*$/.test(c.key) || keys.has(c.key)) throw Error('Unique C-number keys required'); keys.add(c.key);
    text(c.name,80,'name'); text(c.persona,6000,'persona'); text(c.speaking_style,400,'speaking style'); text(c.appearance_prompt,1000,'appearance');
    if (!['player','coplayer','npc'].includes(c.kind)) throw Error('Invalid character kind');
    if (c.kind === 'player') { if (!s.participants[c.owner_user_id]) throw Error('Owner must be a participant'); owned.add(c.owner_user_id); }
    else delete c.owner_user_id;
    if (c.existing_id && !c.expected_updated_at) throw Error('Existing card needs its version');
    if (!c.role_card || typeof c.role_card !== 'object') throw Error('Role card required');
  }
  for (const u of Object.keys(s.participants)) if (!owned.has(u)) throw Error('Each participating player needs a character');
  if (s.rule === 'pbta') {
    validatePack(x.pack);
    for (const c of x.characters) { try {validateActor(c,x.pack,{takenNames:[],existing:c.existing_id});} catch(e) {throw Error(c.key+": "+e.message);} for (const k of ['stats','resources']) for (const field of x.pack[k]) if (!Number.isInteger(c.role_card.pbta[k]?.[field.id])) throw Error(`Missing ${c.key} ${k}.${field.id}`); }
  }
  return x;
}
export async function compile(llm, s, { language, rules, existing, cfg, api, channel }) {
  const profile = rulesProfile(s.rule), pointsMode = Boolean(channel.point_buy);
  const context = JSON.stringify({ dossier: publicDossier(s), existing, coplayers: cfg.coplayers, level: cfg.level });
  let feedback = '';
  let candidate;
  for (let attempt = 0; attempt < 3; attempt++) {
    const prose = await completeText(llm, { purpose: 'forge_compile', system: `Write a complete PUBLIC pre-game world and cast in ${language}, as expressive plain prose. This becomes the official world. Preserve players' accepted decisions and existing identity; explicitly coordinate conflicting preferences, do not silently discard them. Include genre/tone, boundaries, daily life, locations, factions, relationships, conflicts, hooks, and opening conditions without playing them out. Players' characters belong to named participating users; other cast are AI co-players or NPCs. Keep secrets and hidden NPC motives out of all public cards. PbtA: design playbooks AND their characters together, allowing either to change in service of the other, with meaningful triggers, risks, mixed outcomes and individual agency. No fixed playbook-first adaptation.\n${feedback ? 'Independent critique (repair without altering accepted choices): '+feedback : ''}`, user: context });
    candidate = await completeJson(llm, { purpose: 'forge_compile', maxRepairs: 2, system: `Compile the public prose into one JSON object {world:string (<=25000 characters),opening:string,characters:[${castShape}]${s.rule === 'pbta' ? ',pack: a complete schemaVersion 1 PbtA pack' : ''}}. Stable C-number character keys; reuse priorCast keys for the same characters; match existing characters by ID and include exact expected_updated_at. No secrets anywhere. Never fabricate owner IDs. The world must include a compact public cast and their relationships; full role cards are separate. ${s.rule === 'pbta' ? 'Jointly produce the pack and numerical sheets, revising both together; include every stat and resource value. The supplied pack is a schema example, not a preselected design. Include rolled and diceless moves, shared and playbook-exclusive moves. Every move has playerChoiceBands:[] or the outcome band IDs requiring a player choice (diceless uses no_roll). Rolled move outcomes cover all bands, diceless moves use stat:"" and outcomes:{}, shared moves book:""; include books, moves, gmMoves (generic public-safe guidance only), bands with contiguous min/max (outer bound null), resources, stats, conditions. Card role_card.pbta:{book,stats:{id:integer},resources:{id:integer},conditions:{id:boolean}}.' : `Each character uses this full card shape: ${profile.card.shape}. ${profile.card.creationHint(cfg.level)} ${profile.card.rulesSummary(rules,pointsMode,cfg.level)}`} Text language ${language}.`, user: JSON.stringify({ prose, existing, participants:s.participants, packTemplate:s.rule === 'pbta' ? rules.pack : undefined }) }, x => { validateCandidate(x,s); if(s.rule!=='pbta') for(const c of x.characters) profile.card.validateGenerated(c,{rules,pointsMode}); return x; });
    const previous=[...(s.drafts??[]).flatMap(d=>d.candidate.characters),...(s.candidate?.characters??[])];
    let nextKey=Math.max(0,...previous.map(c=>Number(c.key.slice(1))));
    const assigned=new Set();
    for(const c of candidate.characters) {
      const prior=previous.find(p=>p.kind===c.kind && (c.existing_id ? p.existing_id===c.existing_id : c.kind==='player' ? p.owner_user_id===c.owner_user_id : p.name===c.name));
      c.key=prior && !assigned.has(prior.key) ? prior.key : `C${++nextKey}`;assigned.add(c.key);
    }
    const seenIds=new Set();
    for (const c of candidate.characters) {
      if(c.existing_id) {
        const prior=existing.find(e=>e.id===c.existing_id);
        if(!prior || seenIds.has(c.existing_id) || c.expected_updated_at!==prior.updated_at || prior.kind!==(c.kind==='npc'?'npc':'pc') || (c.kind==='player' && prior.user_id!==c.owner_user_id) || (c.kind==='coplayer' && s.participants[prior.user_id])) throw Error('Existing character identity/version differs; review again');
        seenIds.add(c.existing_id);
      }
      if (s.rule !== 'pbta') {
        profile.card.validateGenerated(c,{rules,pointsMode});
        c.role_card = profile.card.normalize(c.role_card,{ rules,kind:c.kind === 'npc' ? 'npc' : 'coplayer',level:cfg.level,pointsMode });
        if (s.rule === 'coc7e' && pointsMode) c.role_card = await allocatePointBuy(llm,c.role_card,{rules,language});
        if (s.rule === 'dnd2024' && profile.card.check(c.role_card,rules).violations?.length) c.role_card = await profile.card.repair(llm,c.role_card,{rules,language,level:cfg.level});
      }
      if(s.rule !== 'pbta') for(let repair=0;;repair++) {
        try {c.role_card=(await api.previewCard(channel.id,{rule_system:s.rule,role_card:c.role_card})).role_card;break;}
        catch(e) {if(e.code!=='points_rule'||repair>=2) throw e;c.role_card=await profile.card.repair(llm,c.role_card,{rules,language,level:cfg.level,feedback:e.message});}
      }
      c.role_card.basic ??= {}; c.role_card.basic.player = c.kind === 'player' ? s.participants[c.owner_user_id].name : c.kind === 'npc' ? 'NPC' : 'AI co-player';
    }
    if (s.rule === 'pbta') {
      const normalized = await api.previewPbta(channel.id,{pack:candidate.pack,characters:candidate.characters});
      candidate.pack=normalized.pack; candidate.characters=normalized.characters;
    }
    const review = await completeJson(llm, { purpose:'forge_review', system:`Independently critique this pre-game candidate against accepted decisions. Check agency, contradictions, ownership, numerical completeness, romance boundaries and playable hooks. For PbtA check the joint world/playbook/sheet design in BOTH directions, triggers, costs, all outcomes and sheet values. Return {ok:boolean,issues:[string],substantive:boolean}. Do not rewrite or start play.`,user:JSON.stringify({dossier:publicDossier(s),candidate}) }, x => { if(typeof x.ok!=='boolean'||!Array.isArray(x.issues)||x.issues.some(i=>typeof i!=='string')) throw Error('Invalid critique'); return x; });
    s.review=review;
    if (review.ok) return candidate;
    feedback=review.issues.join('\n');
    if (review.substantive || attempt === 2) throw Error('草案需要补充决定：'+feedback);
  }
}
export async function secrets(llm,s,language) {
  return completeText(llm,{purpose:'forge_secrets',system:`Write only GM-private background truth in ${language}, <=20000 characters. Preserve the approved public world and all player decisions. Offer hidden pressures and flexible NPC motives without predetermining player choices. No new mandatory public facts or mechanical changes. Never place these secrets in public role cards.`,user:JSON.stringify({candidate:s.candidate,privateSource:s.sourceSecrets})}).then(x=>text(x,20000,'private world'));
}
export async function playtest(llm,s,depth) {
  const [probes,rounds]=({quick:[2,2],standard:[4,3],deep:[6,3]})[depth] ?? [];
  if (!probes) throw Error('试跑模式应为 quick、standard 或 deep');
  const reports=[];
  for(let p=0;p<probes;p++) {
    const transcript=[];
    for(let r=0;r<rounds;r++) transcript.push(await completeText(llm,{purpose:'forge_playtest',system:`Isolated pre-game simulation. No real tools or state writes. Probe ${p+1}/${probes}, turn ${r+1}/${rounds}; ${depth==='deep'&&p>=4?'midstory pressure':'opening agency, relationship and rule pressure'}. Simulate a concrete player choice and its GM/rules consequences, respecting boundaries. Report contradictions and dead ends candidly.`,user:JSON.stringify({candidate:s.candidate,transcript})}));
    reports.push(transcript);
  }
  return { depth,revision:s.revision,reports,at:new Date().toISOString() };
}
