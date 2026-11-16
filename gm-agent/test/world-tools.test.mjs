import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlm } from '../src/llm/index.mjs';
import { completeWithTools } from '../src/llm/tools.mjs';
const tools=[{name:'read_state',description:'Read state',schema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}}];
const sse=x=>`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`;
const stream=events=>new Response(events.map(sse).join(''),{headers:{'content-type':'text/event-stream'}});
const request={system:'private',user:'scene',purpose:'gm',retryDelay:()=>Promise.resolve()};

test('Responses tool round preserves encrypted reasoning, fragmented arguments and call IDs',async t=>{
  const seen=[],usage=[],reason={type:'reasoning',id:'r1',summary:[],encrypted_content:'encrypted'};
  t.mock.method(globalThis,'fetch',async(_,opts)=>{
    seen.push(JSON.parse(opts.body));
    return seen.length===1?stream([
      {type:'response.output_item.done',output_index:0,item:reason},
      {type:'response.output_item.added',output_index:1,item:{type:'function_call',id:'fc1',call_id:'c1',name:'read_state',arguments:''}},
      {type:'response.function_call_arguments.delta',output_index:1,delta:'{"id":"'},
      {type:'response.function_call_arguments.delta',output_index:1,delta:'NPC"}'},
      {type:'response.completed',response:{status:'completed',usage:{input_tokens:30,output_tokens:5}}}
    ]):Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'She opens the journal.'}]}],usage:{input_tokens:40,output_tokens:7}});
  });
  const provider=createLlm({provider:'openai',apiBase:'https://fixture.invalid/v1',model:'gpt-fixture'});
  const llm={complete:r=>provider.complete({...r,onUsage:u=>usage.push(u)})};let calls=0;
  assert.equal(await completeWithTools(llm,{...request,toolkit:{tools,call:(name,args)=>{calls++;assert.deepEqual(args,{id:'NPC'});return {trust:6};}}}),'She opens the journal.');
  assert.equal(calls,1);assert.equal(usage.length,2);assert.deepEqual(seen[0].include,['reasoning.encrypted_content']);
  assert.deepEqual(seen[1].input[1],reason);assert.equal(seen[1].input[2].arguments,'{"id":"NPC"}');
  assert.deepEqual(seen[1].input[3],{type:'function_call_output',call_id:'c1',output:'{"trust":6}'});
  assert.equal(seen[1].store,false);
});
test('Anthropic tool round replays signed thinking and tool result blocks intact',async t=>{
  const seen=[];
  t.mock.method(globalThis,'fetch',async(_,opts)=>{
    seen.push(JSON.parse(opts.body));
    return seen.length===1?stream([
      {type:'message_start',message:{id:'m1',type:'message',role:'assistant',model:'fixture',content:[],usage:{input_tokens:3}}},
      {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},
      {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Read first'}},
      {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'signature'}},
      {type:'content_block_stop',index:0},
      {type:'content_block_start',index:1,content_block:{type:'tool_use',id:'c1',name:'read_state',input:{}}},
      {type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"id":'}},
      {type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'"NPC"}'}},
      {type:'content_block_stop',index:1},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}},{type:'message_stop'}
    ]):Response.json({type:'message',role:'assistant',content:[{type:'text',text:'She pauses.'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:3}});
  });
  const llm=createLlm({provider:'anthropic',apiBase:'https://fixture.invalid',apiKey:'fixture',model:'fixture',fallbacks:false});
  assert.equal(await completeWithTools(llm,{...request,toolkit:{tools,call:()=>({trust:2})}}),'She pauses.');
  assert.deepEqual(seen[1].messages[1].content[0],{type:'thinking',thinking:'Read first',signature:'signature'});
  assert.deepEqual(seen[1].messages[1].content[1].input,{id:'NPC'});
  assert.deepEqual(seen[1].messages[2].content,[{type:'tool_result',tool_use_id:'c1',content:'{"trust":2}'}]);
});
test('tool loops deduplicate IDs, return validation errors and stop within their budget',async()=>{
  let calls=0,requests=0;
  const call={id:'once',name:'read_state',arguments:'{"id":"NPC"}'};
  const llm={complete:async r=>{requests++;if(requests<=2)return {calls:[call],providerOutput:[{type:'function_call'}]};assert.deepEqual(r.messages.at(-1).toolResults[0].result,{error:'invalid fixture'});return {text:'Final',calls:[]};}};
  assert.equal(await completeWithTools(llm,{...request,toolkit:{tools,call:()=>{calls++;throw Error('invalid fixture');}}}),'Final');assert.equal(calls,1);
  requests=0;
  await assert.rejects(completeWithTools({complete:async r=>{requests++;if(requests===4)assert.equal(r.toolChoice,'none');return {calls:[call],providerOutput:[{}]};}},{...request,toolkit:{tools,call:()=>({})}}),/limit exceeded/);
  assert.equal(requests,4);
});
test('cancellation after a provider reply prevents tool execution',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(completeWithTools({complete:async()=>{controller.abort();return {calls:[{id:'c',name:'read_state',arguments:'{}'}],providerOutput:[{}]};}},{...request,signal:controller.signal,toolkit:{tools,call:()=>{calls++;}}}));
  assert.equal(calls,0);
});
