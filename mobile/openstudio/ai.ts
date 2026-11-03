// Only data crosses this boundary. Provider credentials and HTTP stay in the native app.
import { composeDraft, continueDraft, resumeDraft, appendScript } from '../../frontend/src/openstudio/vn';
import { carriesReasoning, replayableBlocks } from '../../frontend/src/openstudio/vn/replay';
import type { Project, LlmRequest, LlmAnswer, VnDraft } from '../../frontend/src/openstudio/types';
type Config = { provider: string; model: string; endpoint: string };
type Journal = { request: string; answer: LlmAnswer }[];
type Checkpoint = { mode: string; language: string; instructions: string; identity: string; stamp: string; journal: Journal };
type Job = { checkpoint: Checkpoint; state: string; done: number; total: number; request?: any; accept?: (x:any)=>void; reject?: (e:Error)=>void; project?: Project; error?: string; ctrl: AbortController };
const jobs = new Map<string,Job>(); let counter = 0;
function canonical(v:any): string { return JSON.stringify(v,(_,x)=>x && typeof x==='object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])) : x); }
function stamp(p:Project) {
  const text=canonical({events:p.events,characters:p.characters,background:p.background,vn:p.vn,vn_draft:p.vn_draft,title:p.title});
  let a=2166136261,b=5381; for(let i=0;i<text.length;i++) { a=Math.imul(a^text.charCodeAt(i),16777619); b=Math.imul(b,33)^text.charCodeAt(i); }
  return `${text.length}:${a>>>0}:${b>>>0}`;
}
function wire(req:LlmRequest,c:Config,plain=false) {
  if(c.provider==='anthropic') {
    const blocks=req.replay && !plain ? replayableBlocks(req.replay.turn,'anthropic',c.model) : null;
    const messages:any[]=[{role:'user',content:req.user}];
    if(req.replay) messages.push({role:'assistant',content:blocks ?? req.replay.turn.text},{role:'user',content:req.replay.followUp});
    return {body:{model:c.model,max_tokens:req.max_tokens ?? 16000,system:req.system,messages},retryPlain:carriesReasoning(blocks)};
  }
  const messages:any[]=[{role:'system',content:req.system},{role:'user',content:req.user}];
  if(req.replay) messages.push({role:'assistant',content:req.replay.turn.text},{role:'user',content:req.replay.followUp});
  return {body:{model:c.model,messages,...(req.json?{response_format:{type:'json_object'}}:{}),...(req.max_tokens?{max_completion_tokens:req.max_tokens}:{})},retryPlain:false};
}
function answer(response:any,c:Config): LlmAnswer {
  const j=response.body; if(!j || typeof j!=='object') throw Error('Invalid AI response');
  const blocks=c.provider==='anthropic' && Array.isArray(j.content) ? j.content : [];
  const text=c.provider==='anthropic' ? blocks.filter((x:any)=>x?.type==='text').map((x:any)=>x.text).join('') : j.choices?.[0]?.message?.content;
  if(typeof text!=='string' || !text.trim()) throw Error('The AI service returned no text');
  return {text,turn:{provider:c.provider,model:typeof j.model==='string'?j.model:c.model,text,blocks}};
}
function snapshot(id:string,j:Job) { return {id,state:j.state,done:j.done,total:j.total,checkpoint:j.checkpoint,request:j.request,project:j.project,error:j.error}; }
export async function aiAction(input:any): Promise<any> {
  if(input.action==='aiStart') {
    if(jobs.size) throw Error('An AI task is already running');
    const p=structuredClone(input.project) as Project & {mobile_ai_job?:Checkpoint}; const c=input.config as Config;
    if(!['openai','anthropic'].includes(c?.provider) || !c.model?.trim()) throw Error('Configure an AI service first');
    const saved=p.mobile_ai_job; const identity=canonical(c);
    let checkpoint:Checkpoint;
    if(input.mode==='retry') {
      if(!saved || saved.stamp!==stamp(p) || saved.identity!==identity) throw Error('Project or AI service changed; discard the unfinished task and start again');
      checkpoint=structuredClone(saved);
    } else {
      if(saved) throw Error('Resume or discard the unfinished task first');
      if(!['compose','continue','resume'].includes(input.mode)) throw Error('Invalid script action');
      if(input.mode!=='resume' && p.vn_draft) throw Error('Answer or discard the current draft first');
      checkpoint={mode:input.mode,language:input.mode==='resume'?p.vn_draft?.language??input.language:input.language,instructions:input.mode==='resume'?p.vn_draft?.instructions??'':input.instructions??'',identity,stamp:stamp(p),journal:[]};
    }
    const id=String(++counter),j:Job={checkpoint,state:'running',done:0,total:0,ctrl:new AbortController()}; jobs.set(id,j);
    let cursor=0;
    const remote=(request:any)=>new Promise<any>((resolve,reject)=>{ j.request=request; j.accept=resolve; j.reject=reject; });
    const llm=async(req:LlmRequest):Promise<LlmAnswer>=>{
      if(j.ctrl.signal.aborted) throw Error('Cancelled');
      const key=canonical({...req,signal:undefined}); const cached=checkpoint.journal[cursor++];
      if(cached) { if(cached.request!==key) throw Error('Saved AI response no longer matches the project'); return cached.answer; }
      const request=wire(req,c); let response=await remote(request);
      if(response.status===400 && request.retryPlain) response=await remote(wire(req,c,true));
      if(response.status<200 || response.status>=300) throw Error(`AI service returned HTTP ${response.status}`);
      const value=answer(response,c); checkpoint.journal.push({request:key,answer:value}); return value;
    };
    const opts={llm,language:checkpoint.language,instructions:checkpoint.instructions,signal:j.ctrl.signal,onProgress:(done:number,total:number)=>{j.done=done;j.total=total;},backgrounds:(p.vn?.script.scenes??[]).filter(s=>s.background).map(s=>({name:s.title,path:s.background!}))};
    void (async()=>{
      try {
        const mode=checkpoint.mode==='resume'?p.vn_draft?.mode:checkpoint.mode;
        let r:any;
        if(checkpoint.mode==='resume') { if(!p.vn_draft) throw Error('No draft'); r=await resumeDraft(p,opts,p.vn_draft); }
        else r=await (mode==='continue'?continueDraft(p,opts):composeDraft(p,opts));
        if(j.ctrl.signal.aborted) return;
        delete p.mobile_ai_job;
        if(r.draft) { r.draft.events=p.events.length; p.vn_draft=r.draft; }
        else {
          if(mode==='continue' && p.vn) { p.vn.script=appendScript(p.vn.script,r.script,r.note??''); p.vn.language=checkpoint.language;p.vn.instructions=checkpoint.instructions;p.vn.composed_at=new Date().toISOString(); }
          else p.vn={script:r.script,template:p.vn?.template??{},audio:{},narrator_voice:p.vn?.narrator_voice??'',language:checkpoint.language,instructions:checkpoint.instructions,composed_at:new Date().toISOString()};
          delete p.vn_draft;
        }
        j.project=p;j.state='done';
      } catch(e) {j.error=e instanceof Error?e.message:String(e); j.state='failed';}
      finally {j.request=undefined;}
    })();
    await Promise.resolve(); const result=snapshot(id,j); if(j.state==='done'||j.state==='failed') jobs.delete(id); return result;
  }
  const id=String(input.id),j=jobs.get(id); if(!j) throw Error('AI task expired; resume the saved task');
  if(input.action==='aiCancel') {j.ctrl.abort();j.reject?.(Error('Cancelled'));jobs.delete(id);return {};}
  if(input.action==='aiAnswer') { if(!j.accept || !j.request) throw Error('No AI request is pending'); const accept=j.accept;j.accept=undefined;j.request=undefined;accept(input.response); }
  else if(input.action!=='aiPoll') throw Error('Unknown AI action');
  await Promise.resolve();await Promise.resolve();
  const result=snapshot(id,j); if(j.state==='done'||j.state==='failed') jobs.delete(id); return result;
}
