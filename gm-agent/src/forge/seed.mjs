import { completeJson } from '../llm/index.mjs';
import { seedWorldState } from '../world-state/state.mjs';
export const seedSource = s => `forge:${s.id}:${s.revision}`;
// The seed is GM-private. Public interviews, cards and approval messages never receive it.
export async function createSeed(llm,s) {
  return completeJson(llm,{purpose:'forge_seed',maxRepairs:2,system:`Prepare a SMALL GM-private initial world state from this approved world and its hidden background. Return JSON {definitions:[],values:[]}; empty arrays are valid when nothing needs tracking. Definitions: {id:stable_ascii,label,description,scope:"relation|character|world",type:"number|boolean|enum",initial, min:number,max:number (numbers only), options:[strings] (enum only),maxChangePerScene?:positive number,changeRule:concrete narrative constraints,thresholds:[{id,event,when:{all:[{metric,op:">=|<=|>|<|==|!=",value}]}}]}. Threshold references must have the same scope. Values: {metric,subject:"C1",target:"C2",value,reason}. Use ONLY the supplied C-keys. Relation subjects MUST be NPCs, targets may be human PCs or other NPCs; keep every ordered pair independent, with no automatic reciprocity or whole-party score. Character scope omits target, world scope omits both. No inventory here: role_card.items already owns equipment. Seed only relationships or conditions supported by the setting, never a full-cast matrix. Threshold events offer story opportunities, never force a human action or decide their feelings. Do not change accepted public facts.`,user:JSON.stringify({world:s.candidate.world,opening:s.candidate.opening,characters:s.candidate.characters,secrets:s.privateWorld})},x=>{
    if(!Array.isArray(x.definitions)||!Array.isArray(x.values)) throw Error('Seed needs definitions and values');
    const seed={definitions:x.definitions,values:x.values.map(r=>({metric:r.metric,subject:r.subject??'',target:r.target??'',value:r.value,reason:r.reason??'Initial setting'}))};
    seedWorldState(null,seed,{characters:s.candidate.characters.map(c=>({id:c.key,kind:c.kind==='player'?'pc':'npc'})),sourceId:seedSource(s)});
    return seed;
  });
}
export function importSeed(state,s,characters) {
  if(!s.worldStateSeed) return state;
  return {...state,worldState:seedWorldState(state.worldState,s.worldStateSeed,{characterIds:s.characterIds,characters,sourceId:seedSource(s)})};
}
