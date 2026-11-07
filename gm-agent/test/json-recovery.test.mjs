import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { completeJson, createLlm } from '../src/llm/index.mjs';
import { metered } from '../src/llm/parts.mjs';
import { withProgress } from '../src/llm/progress.mjs';
import { JsonFieldError, applyFieldRepairs } from '../src/llm/json-repair.mjs';
import { transientLlmError } from '../src/llm/retry.mjs';
import { prepareActor } from '../src/pbta.mjs';

const options = { system: 'Return a JSON object', user: 'Make a draft', purpose: 'pbta_design', retryDelay: () => 0 };
const interrupted = () => Object.assign(Error('stream disconnected before completion: stream closed before response.completed'), { code: 'LLM_STREAM_INTERRUPTED' });

test('real Responses stream drops are retried, partial text discarded, and each attempt is metered', async t => {
  const inputs = [], records = [], logs = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    inputs.push(JSON.parse(body));
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    if (inputs.length < 3) {
      res.end('data: {"type":"response.output_text.delta","delta":"{\\"unfinished\\":true}"}\n\n');
    } else {
      res.end('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}],usage:{input_tokens:10,output_tokens:5}}})+'\n\n');
    }
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const model = createLlm({provider:'openai_compatible',apiBase:`http://127.0.0.1:${server.address().port}`,model:'fixture',timeoutMs:2000});
  const llm = metered(withProgress(model, s => logs.push(s)), {sink:r => records.push(r)});
  assert.deepEqual(await completeJson(llm, options), {ok:true});
  assert.equal(inputs.length,3); assert.deepEqual(inputs[0].input,inputs[2].input);
  assert.deepEqual(records.map(r=>[r.attempt,r.status,r.usageKnown]),[[1,'failed',false],[2,'failed',false],[3,'completed',true]]);
  assert.equal(new Set(records.map(r=>r.requestId)).size,1);
  assert.equal(logs.filter(l=>l.includes('connection interrupted')).length,2);
});

test('disconnects have a finite budget and never turn a partial answer into a result', async () => {
  let calls=0;
  await assert.rejects(completeJson({complete:async()=>{calls++;throw interrupted();}},options),/stream disconnected/);
  assert.equal(calls,3);
});

test('transport retry budget is shared across field repairs', async () => {
  const responses=[interrupted(),'{"count":"bad"}',interrupted(),'{"repairs":[{"path":"/count","value":"still bad"}]}',interrupted()];
  let calls=0;
  const llm={complete:async()=>{const response=responses[calls++]; if(response instanceof Error)throw response; return response;}};
  await assert.rejects(completeJson(llm,{...options,maxRepairs:3},x=>{
    if(!Number.isInteger(x.count))throw new JsonFieldError('/count','Expected an integer');return x;
  }),/stream disconnected/);
  assert.equal(calls,5);
});

test('refusals, truncation and permanent HTTP errors are not retried', async () => {
  for(const error of [Object.assign(Error('bad request'),{status:400}),Object.assign(Error('unauthorized'),{status:401}),Object.assign(Error('forbidden'),{status:403}),Error('the model declined'),Error('output was truncated by the token limit')]) {
    let calls=0;
    await assert.rejects(completeJson({complete:async()=>{calls++;throw error;}},options),e=>e===error);
    assert.equal(calls,1);
  }
  assert.equal(transientLlmError(Object.assign(Error('busy'),{status:503})),true);
  assert.equal(transientLlmError(Error('LLM stream: invalid API key')),false);
});

test('cancelling a turn interrupts backoff immediately and never starts a second inference', async () => {
  const controller=new AbortController();let calls=0;
  const llm=metered({complete:async()=>{calls++;throw interrupted();}},{signalOf:()=>controller.signal});
  const result=completeJson(llm,{...options,retryDelay:()=>10000});
  setTimeout(()=>controller.abort(Error('turn cancelled')),20);
  await assert.rejects(result,/turn cancelled/); assert.equal(calls,1);
});

test('field repair preserves valid content, rejects unrelated edits, then accepts only the requested field', async () => {
  const draft={name:'Keep my name',sheet:{conditions:['tired'],stats:{nerve:2}},story:'Keep this exact text.'};
  const replies=[JSON.stringify(draft),JSON.stringify({repairs:[{path:'/name',value:'Changed'}]}),JSON.stringify({repairs:[{path:'/sheet/conditions',value:{tired:false}}]})];
  const requests=[];
  const value=await completeJson({complete:async req=>{requests.push(structuredClone(req));return replies.shift();}},{...options,maxRepairs:3},x=>{
    if(Array.isArray(x.sheet.conditions))throw new JsonFieldError('/sheet/conditions','Expected a boolean map');return x;
  });
  assert.deepEqual(value,{...draft,sheet:{...draft.sheet,conditions:{tired:false}}});
  assert.deepEqual(draft.sheet.conditions,['tired']);
  assert.deepEqual(requests[1].repairPaths,['/sheet/conditions']);
  assert.match(requests[2].messages.at(-1).content,/last repair was rejected/);
});

test('unsafe paths, duplicate replacements, array overflow and full-document repair replies are rejected', () => {
  for(const [original,patch,paths] of [
    [{}, {repairs:[{path:'/__proto__/polluted',value:true}]}, ['/__proto__/polluted']],
    [{a:1,b:2}, {repairs:[{path:'/a',value:2},{path:'/a',value:3}]}, ['/a','/b']],
    [{a:[1]}, {repairs:[{path:'/a/1',value:3}]}, ['/a/1']],
    [{a:1}, {a:2}, ['/a']],
  ]) assert.throws(()=>applyFieldRepairs(original,patch,paths));
  assert.equal({}.polluted,undefined);
});

test('a malformed JSON reply still gets a full JSON repair when no parsed fields exist', async () => {
  let calls=0;
  assert.deepEqual(await completeJson({complete:async()=>++calls===1?'not json':'{"ok":true}'},options),{ok:true});
  assert.equal(calls,2);
});

test('permission and stale-draft errors during validation do not regenerate the design', async () => {
  for(const status of [400,403,409,503]) {
    let calls=0;
    await assert.rejects(completeJson({complete:async()=>{calls++;return '{"ok":true}';}},options,()=>{throw Object.assign(Error('platform rejected the request'),{status});}),e=>e.status===status);
    assert.equal(calls,1);
  }
});

test('PbtA actor repairs resources and conditions together, preserving identity, background and stats', async () => {
  const pack={books:[{id:'scout'}],stats:[{id:'nerve'}],resources:[{id:'supply'}],conditions:[{id:'tired'}],moves:[]};
  const draft={name:'Ann',persona:'Original biography',appearance_prompt:'Original portrait',role_card:{basic:{age:24},background:{home:'Harbour'},pbta:{book:'scout',stats:{nerve:2},resources:'plenty',conditions:{tired:'somewhat'}}}};   // not fixable without the model (fitSheet leaves them)
  const requests=[],writes=[];
  const llm={complete:async req=>{
    requests.push(structuredClone(req));
    return requests.length===1?JSON.stringify(draft):JSON.stringify({repairs:[{path:'/role_card/pbta/resources',value:{supply:3}},{path:'/role_card/pbta/conditions',value:{tired:false}}]});
  }};
  const api={createCharacter:async()=>({id:'ann'}),characterSpace:async()=>({character:{id:'ann',role_card:{}}}),putCard:async(_c,_id,body)=>{writes.push(body);return {character:{id:'ann',role_card:body.role_card}};},putAppearance:async()=>({})};
  await prepareActor(api,llm,'ch',{rules:{pack,revision:1},language:'English'});
  assert.equal(requests.length,2);
  assert.deepEqual(requests[1].repairPaths,['/role_card/pbta/resources','/role_card/pbta/conditions']);
  assert.deepEqual(writes[0].role_card,{...draft.role_card,pbta:{...draft.role_card.pbta,resources:{supply:3},conditions:{tired:false}}});
  assert.equal(writes[0].bio,draft.persona);
});
