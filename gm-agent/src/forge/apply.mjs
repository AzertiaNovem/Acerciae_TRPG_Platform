import { allApproved, hash } from './state.mjs';
// Each intent is persisted before the request. Server receipts make retries after a lost response safe.
export async function applyCandidate({ api, channel, session:s, save, gmId }) {
  if (!allApproved(s)) throw Error('需要所有参与者确认同一版本的世界、规则与自己的角色。');
  if (!(await api.channel(channel.id)).forge_eligible) throw Error('正式剧情已经开始，不能启用 Forge。');
  s.phase='applying'; save();
  const once = async (key, body, fn) => {
    const prior=s.journal[key];
    if (prior?.done) return prior.result;
    const intent=prior?.body ?? {...body,request_id:`forge:${s.id}:${s.revision}:${key}`};
    s.journal[key]={body:intent,done:false}; save();
    const result=await fn(intent); s.journal[key]={body:intent,done:true,result}; save(); return result;
  };
  let actors=[];
  if(s.rule==='pbta') {
    const current=await api.pbtaDraft(channel.id);
    const draft=await once('submit',{op:'forge_submit',version:current.version,revision:s.packRevision,world_hash:hash(s.candidate.world),pack:s.candidate.pack,characters:s.candidate.characters},b=>api.reviewPbta(channel.id,b));
    const active=await once('activate',{op:'activate',version:draft.version,revision:draft.revision,pack:draft.pack,characters:draft.characters},b=>api.reviewPbta(channel.id,b));
    actors=active.applied.characters;
  } else {
    for(const c of s.candidate.characters) {
      const created=c.existing_id ? {id:c.existing_id,updated_at:c.expected_updated_at} : await once(`create-${c.key}`,{name:c.name,kind:c.kind==='npc'?'npc':'pc',speaking_style:c.speaking_style},b=>api.createCharacter(channel.id,b));
      const result=await once(`card-${c.key}`,{name:c.name,bio:c.persona,speaking_style:c.speaking_style,role_card:c.role_card,rule_system:s.rule,expected_updated_at:created.updated_at},b=>api.putCard(channel.id,created.id,b));
      await once(`appearance-${c.key}`,{appearance_prompt:c.appearance_prompt},b=>api.putAppearance(channel.id,created.id,b));
      actors.push({key:c.key,character:result.character});
    }
  }
  s.characterIds=Object.fromEntries(actors.map(a=>[a.key,a.character.id])); save();
  for(const c of s.candidate.characters) if(c.kind==='player' && !c.existing_id) {
    await once(`owner-${c.key}`,{user_id:c.owner_user_id,expected_user_id:gmId},b=>api.transferCharacter(channel.id,s.characterIds[c.key],b));
  }
  s.phase='ready'; save();
  return s.characterIds;
}
